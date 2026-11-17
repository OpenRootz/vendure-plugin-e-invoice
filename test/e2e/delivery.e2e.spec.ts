import { Customer, Order, TransactionalConnection } from '@vendure/core';
import { EmailDetails, EmailPlugin, EmailSender, FileBasedTemplateLoader } from '@vendure/email-plugin';
import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EInvoice, EInvoiceDelivery, EInvoiceModel, EInvoicePlugin } from '../../src';
import { eInvoiceDeliveryHandler } from '../../src/email';
import { EMAIL_PLUGIN_ATTEMPTS } from '../../src/strategies/email-plugin-delivery-strategy';
import { initialData } from '../fixtures/initial-data';
import { prepareEmailTemplates } from '../email-templates';
import { createConfig, fixtures } from '../helpers';

import { InvoiceResult, placeOrder, readFiles, SELLER_SETTINGS, UPDATE_SETTINGS, waitForInvoices } from './helpers';

/** Captures the emails instead of sending them; `failures` makes the next sends throw. */
class CapturingSender implements EmailSender {
  sent: EmailDetails[] = [];
  attempts = 0;
  failures = 0;

  send(email: EmailDetails) {
    this.attempts++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('SMTP server not reachable');
    }
    this.sent.push(email);
  }
}

const sender = new CapturingSender();

const templateDir = prepareEmailTemplates(path.join(__dirname, '../__output__/email-templates'));

const DELIVERY_FIELDS = `
  id
  status
  trigger
  recipient
  bcc
  attempts
  linkOnly
  errorMessage
  sentAt
`;

const INVOICE_DELIVERIES = gql`
  query ($id: ID!) {
    eInvoice(id: $id) {
      id
      number
      deliveries {
        ${DELIVERY_FIELDS}
      }
    }
  }
`;

const SEND = gql`
  mutation ($id: ID!, $recipient: String) {
    sendEInvoice(id: $id, recipient: $recipient) {
      ${DELIVERY_FIELDS}
    }
  }
`;

const SETTINGS = gql`
  query {
    eInvoiceChannelSettings {
      delivery {
        enabled
        bcc
      }
    }
    eInvoiceSetupWarnings {
      code
      message
    }
  }
`;

const ORDER_EMAIL = gql`
  query ($id: ID!) {
    order(id: $id) {
      customer {
        emailAddress
      }
    }
  }
`;

const REQUEST_LINK = gql`
  mutation ($orderCode: String!, $emailAddress: String!) {
    requestInvoiceDownloadLink(orderCode: $orderCode, emailAddress: $emailAddress) {
      success
    }
  }
`;

const CANCEL_AND_REISSUE = gql`
  mutation ($invoiceId: ID!) {
    cancelAndReissueEInvoice(invoiceId: $invoiceId) {
      id
    }
  }
`;

interface DeliveryResult {
  id: string;
  status: string;
  trigger: string;
  recipient: string;
  bcc: string | null;
  attempts: number;
  linkOnly: boolean;
  errorMessage: string | null;
  sentAt: string | null;
}

/** IDs as stored in the database (the test server encodes them as `T_<id>`). */
const dbId = (id: string) => id.replace(/^T_/, '');

const issued = (count: number) => (invoices: InvoiceResult[]) => invoices.length === count && invoices.every((i) => i.status === 'ISSUED');

describe('Sending documents', () => {
  const config = createConfig({
    downloadLinks: { baseUrl: 'https://shop.example.com' },
    // German documents (the test channel's language is English)
    mapping: { language: () => 'de' },
  });
  config.plugins.push(
    EmailPlugin.init({
      handlers: [eInvoiceDeliveryHandler],
      templateLoader: new FileBasedTemplateLoader(templateDir),
      transport: { type: 'none' },
      emailSender: sender,
      globalTemplateVars: { fromAddress: '"Demo Shop" <noreply@example.com>' },
    }),
  );
  const { server, adminClient, shopClient } = createTestEnvironment(config);

  const deliveriesOf = async (invoiceId: string): Promise<DeliveryResult[]> =>
    (await adminClient.query(INVOICE_DELIVERIES, { id: invoiceId })).eInvoice.deliveries;

  /**
   * Polls until the document has `count` deliveries and none is queued or retrying. Pick deliveries by ID, not by
   * position: the clock can step back (WSL2), so "newest first" is not reliable in tests.
   */
  const waitForDeliveries = async (invoiceId: string, count: number) => {
    const done = (d: DeliveryResult) => d.status === 'SENT' || d.status === 'FAILED';
    const start = Date.now();
    for (;;) {
      const deliveries = await deliveriesOf(invoiceId);
      if (deliveries.length >= count && deliveries.every(done)) return deliveries;
      if (Date.now() - start > 20_000) throw new Error(`Timeout waiting for deliveries of ${invoiceId}: ${JSON.stringify(deliveries)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const customerEmail = async (orderId: string): Promise<string> =>
    (await adminClient.query(ORDER_EMAIL, { id: orderId })).order.customer.emailAddress;

  beforeAll(async () => {
    await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 1 });
    await adminClient.asSuperAdmin();
    await adminClient.query(UPDATE_SETTINGS, { input: SELLER_SETTINGS });
  });

  afterAll(async () => {
    await server.destroy();
  });

  it('sends nothing while delivery is off for the channel', async () => {
    const order = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 }] });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued(1));
    await new Promise((r) => setTimeout(r, 500));
    expect(await deliveriesOf(invoice.id)).toEqual([]);
    expect(sender.sent).toHaveLength(0);
  });

  it('saves the delivery settings and rejects an invalid BCC address', async () => {
    await adminClient.query(UPDATE_SETTINGS, { input: { delivery: { enabled: true, bcc: 'archiv@example.com' } } });
    const { eInvoiceChannelSettings, eInvoiceSetupWarnings } = await adminClient.query(SETTINGS);
    expect(eInvoiceChannelSettings.delivery).toEqual({ enabled: true, bcc: 'archiv@example.com' });
    // Handler registered, template copied: no warnings about the delivery setup
    expect(eInvoiceSetupWarnings.filter((w: { code: string }) => w.code === 'DELIVERY_SETUP')).toEqual([]);

    await expect(adminClient.query(UPDATE_SETTINGS, { input: { delivery: { bcc: 'a@example.com, b@example.com' } } })).rejects.toThrow(
      'not a valid email address',
    );
  });

  it('sends an issued invoice with the stored PDF attached, BCC to the archive', async () => {
    sender.sent = [];
    const order = await placeOrder(shopClient, { items: [{ sku: 'KAF-500', quantity: 2 }] });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued(1));
    const [delivery] = await waitForDeliveries(invoice.id, 1);

    const email = await customerEmail(order.id);
    expect(delivery).toMatchObject({
      status: 'SENT',
      trigger: 'auto',
      recipient: email,
      bcc: 'archiv@example.com',
      attempts: 1,
      linkOnly: false,
    });
    expect(delivery.sentAt).toBeTruthy();

    expect(sender.sent).toHaveLength(1);
    const [mail] = sender.sent;
    expect(mail.recipient).toBe(email);
    expect(mail.bcc).toBe('archiv@example.com');
    expect(mail.from).toBe('"Demo Shop" <noreply@example.com>');
    expect(mail.subject).toBe(`Rechnung ${invoice.number} – Demo Shop GmbH`);
    expect(mail.body).toContain(`anbei erhalten Sie die Rechnung <strong>${invoice.number}</strong>`);
    expect(mail.body).not.toContain('XRechnung');

    const files = await readFiles(server, invoice.number!);
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]).toMatchObject({ filename: `${invoice.number}.pdf`, contentType: 'application/pdf', encoding: 'base64' });
    expect(Buffer.from(mail.attachments[0].content as string, 'base64').equals(files.zugferd)).toBe(true);
  });

  it('attaches the XRechnung and says that it is authoritative for buyers with a Leitweg-ID', async () => {
    sender.sent = [];
    const order = await placeOrder(shopClient, {
      items: [{ sku: 'NB-A5', quantity: 1 }],
      customFields: { eInvoiceLeitwegId: '04011000-1234512345-06' },
    });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued(1));
    const [delivery] = await waitForDeliveries(invoice.id, 1);
    // The buyer's electronic address is the Leitweg-ID: the email goes to the customer
    expect(delivery.recipient).toBe(await customerEmail(order.id));
    const [mail] = sender.sent;
    expect(mail.attachments.map((a) => a.filename)).toEqual([`${invoice.number}.pdf`, `${invoice.number}-xrechnung.xml`]);
    expect(mail.body).toContain('Maßgeblich ist die XRechnung');
  });

  it('sends the credit note and the new invoice of a cancel and reissue', async () => {
    sender.sent = [];
    const order = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 }] });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued(1));
    await waitForDeliveries(invoice.id, 1);
    await adminClient.query(CANCEL_AND_REISSUE, { invoiceId: invoice.id });
    const docs = await waitForInvoices(adminClient, order.id, issued(3));
    for (const doc of docs.slice(1)) await waitForDeliveries(doc.id, 1);
    const subjects = sender.sent.map((m) => m.subject).sort();
    expect(subjects).toEqual([
      `Rechnung ${docs[0].number} – Demo Shop GmbH`,
      `Rechnung ${docs[2].number} – Demo Shop GmbH`,
      `Rechnungskorrektur ${docs[1].number} – Demo Shop GmbH`,
    ]);
    expect(sender.sent.find((m) => m.subject.startsWith('Rechnungskorrektur'))?.body).toContain(
      'anbei erhalten Sie die Rechnungskorrektur',
    );
  });

  it('sends a document again manually, to another address and without BCC', async () => {
    sender.sent = [];
    const order = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 }] });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued(1));
    await waitForDeliveries(invoice.id, 1);

    const { sendEInvoice } = await adminClient.query(SEND, { id: invoice.id, recipient: 'buchhaltung@kunde.example' });
    expect(sendEInvoice).toMatchObject({ trigger: 'manual', recipient: 'buchhaltung@kunde.example', bcc: null });
    const deliveries = await waitForDeliveries(invoice.id, 2);
    expect(deliveries.find((d) => d.id === sendEInvoice.id)).toMatchObject({ status: 'SENT' });
    expect(deliveries.find((d) => d.id !== sendEInvoice.id)?.trigger).toBe('auto');
    expect(sender.sent.at(-1)).toMatchObject({ recipient: 'buchhaltung@kunde.example' });
    expect(sender.sent.at(-1)?.bcc).toBeUndefined();

    await expect(adminClient.query(SEND, { id: invoice.id, recipient: 'not an address' })).rejects.toThrow('not a valid email address');
  });

  it(`retries a failed email and marks it failed after ${EMAIL_PLUGIN_ATTEMPTS} attempts`, async () => {
    const order = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 }] });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued(1));
    await waitForDeliveries(invoice.id, 1);

    // One failure, then success: retrying, then sent
    sender.failures = 1;
    const { sendEInvoice: once } = await adminClient.query(SEND, { id: invoice.id });
    const recovered = (await waitForDeliveries(invoice.id, 2)).find((d) => d.id === once.id);
    expect(recovered).toMatchObject({ status: 'SENT', attempts: 2, errorMessage: null });

    // Fails every time: the EmailPlugin's job runs 1 + 5 retries (retries: 5); afterwards the delivery is failed
    const attemptsBefore = sender.attempts;
    sender.failures = 100;
    const { sendEInvoice: never } = await adminClient.query(SEND, { id: invoice.id });
    const failed = (await waitForDeliveries(invoice.id, 3)).find((d) => d.id === never.id);
    sender.failures = 0;
    expect(failed).toMatchObject({ status: 'FAILED', attempts: EMAIL_PLUGIN_ATTEMPTS, errorMessage: 'SMTP server not reachable' });
    expect(sender.attempts - attemptsBefore).toBe(EMAIL_PLUGIN_ATTEMPTS);
  }, 60_000);

  it('sends download links instead of attachments above delivery.maxAttachmentBytes', async () => {
    sender.sent = [];
    const order = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 }] });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued(1));
    await waitForDeliveries(invoice.id, 1);

    const limits = EInvoicePlugin.options.delivery;
    const before = limits.maxAttachmentBytes;
    limits.maxAttachmentBytes = 1;
    try {
      const { sendEInvoice } = await adminClient.query(SEND, { id: invoice.id });
      const delivery = (await waitForDeliveries(invoice.id, 2)).find((d) => d.id === sendEInvoice.id);
      expect(delivery).toMatchObject({ status: 'SENT', linkOnly: true });
    } finally {
      limits.maxAttachmentBytes = before;
    }
    const mail = sender.sent.at(-1)!;
    expect(mail.attachments).toEqual([]);
    expect(mail.body).toContain('Die Dateien sind zu groß für einen Anhang');
    const href = /href="(https:\/\/shop\.example\.com\/e-invoice\/download\/[^"]+)"/.exec(mail.body)?.[1] ?? '';
    const url = new URL(href.replace(/&amp;/g, '&'));
    expect(url.pathname).toBe(`/e-invoice/download/${dbId(invoice.id)}`);
    expect(url.searchParams.get('f')).toBe('zugferd');
    expect(url.searchParams.get('sig')).toBeTruthy();
  });

  it('marks a delivery failed when the order has no email address', async () => {
    const order = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 }] });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued(1));
    await waitForDeliveries(invoice.id, 1);
    // Simulate a document whose buyer and customer have no email address
    const connection = server.app.get(TransactionalConnection).rawConnection;
    const { customerId } = await connection.getRepository(Order).findOneByOrFail({ id: dbId(order.id) });
    await connection.getRepository(Customer).update({ id: customerId! }, { emailAddress: '' });
    const doc = await connection.getRepository(EInvoice).findOneByOrFail({ id: dbId(invoice.id) });
    const model = doc.model as EInvoiceModel;
    await connection
      .getRepository(EInvoice)
      .update({ id: dbId(invoice.id) }, { model: { ...model, buyer: { ...model.buyer, electronicAddress: undefined } } });

    const { sendEInvoice } = await adminClient.query(SEND, { id: invoice.id });
    expect(sendEInvoice).toMatchObject({ status: 'FAILED', recipient: '', errorMessage: 'No recipient: the order has no email address' });
  });

  describe('requestInvoiceDownloadLink', () => {
    let order: { id: string; code: string };
    let invoiceId: string;

    beforeAll(async () => {
      order = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 }] });
      [{ id: invoiceId }] = await waitForInvoices(adminClient, order.id, issued(1));
      await waitForDeliveries(invoiceId, 1);
    });

    const request = async (orderCode: string, emailAddress: string) => {
      await shopClient.asAnonymousUser();
      return (await shopClient.query(REQUEST_LINK, { orderCode, emailAddress })).requestInvoiceDownloadLink;
    };

    it('answers success without sending anything when order code or email address do not match', async () => {
      const email = await customerEmail(order.id);
      expect(await request(order.code, 'someone@example.org')).toEqual({ success: true });
      expect(await request('UNKNOWN', email)).toEqual({ success: true });
      expect(await deliveriesOf(invoiceId)).toHaveLength(1);
    });

    it('sends the documents again to the order address, case-insensitive, without BCC', async () => {
      const email = await customerEmail(order.id);
      expect(await request(order.code, `  ${email.toUpperCase()} `)).toEqual({ success: true });
      const requested = (await waitForDeliveries(invoiceId, 2)).find((d) => d.trigger === 'request');
      expect(requested).toMatchObject({ status: 'SENT', recipient: email, bcc: null });
    });

    it('sends at most delivery.requestLimit.max per window and still answers success', async () => {
      const email = await customerEmail(order.id);
      for (let i = 0; i < 4; i++) expect(await request(order.code, email)).toEqual({ success: true });
      await waitForDeliveries(invoiceId, 4);
      const rows = await server.app
        .get(TransactionalConnection)
        .rawConnection.getRepository(EInvoiceDelivery)
        .find({ where: { invoiceId: dbId(invoiceId), trigger: 'request' } });
      expect(rows).toHaveLength(3);
    });
  });
});
