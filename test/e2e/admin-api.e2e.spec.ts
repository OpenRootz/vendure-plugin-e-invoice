import { RequestContext, RequestContextService } from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN } from '@vendure/testing';
import gql from 'graphql-tag';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DefaultTemplatePdfStrategy, PdfTemplateInput } from '../../src';
import { InvoiceRenderService } from '../../src/services/invoice-render.service';
import { initialData } from '../fixtures/initial-data';
import { createConfig, fixtures, usePostgres } from '../helpers';

import { CREATE_INVOICE, E_INVOICE_FIELDS, InvoiceResult, placeOrder, SELLER_SETTINGS, waitForInvoices } from './helpers';

/** Fails rendering while `failing` is set, to produce FAILED invoices. */
class FlakyPdfStrategy extends DefaultTemplatePdfStrategy {
  failing = false;
  buildDocDefinition(ctx: RequestContext, input: PdfTemplateInput) {
    if (this.failing) throw new Error('Template exploded');
    return super.buildDocDefinition(ctx, input);
  }
}

const SETUP_STATUS = gql`
  query {
    eInvoiceSetupStatus {
      code
      message
      path
    }
  }
`;

const SETTINGS = gql`
  fragment Settings on EInvoiceChannelSettings {
    enabled
    autoIssue
    seller {
      name
      tradingName
      vatId
      taxNumber
      address {
        line1
        postalCode
        city
        countryCode
      }
      contact {
        name
        phone
        email
      }
      electronicAddress {
        scheme
        value
      }
      legalRegistration {
        id
      }
      bank {
        iban
        bic
      }
    }
    payment {
      termsText
      termDays
    }
  }
`;

const UPDATE = gql`
  mutation ($input: UpdateEInvoiceChannelSettingsInput!) {
    updateEInvoiceChannelSettings(input: $input) {
      ...Settings
    }
  }
  ${SETTINGS}
`;

const LIST = gql`
  query ($options: EInvoiceListOptions) {
    eInvoices(options: $options) {
      totalItems
      items {
        ...EInvoiceFields
        orderCode
        order {
          id
          code
        }
      }
    }
  }
  ${E_INVOICE_FIELDS}
`;

const PREVIEW = gql`
  query ($orderId: ID!) {
    eInvoicePreview(orderId: $orderId) {
      pdf
      issues {
        code
        message
      }
    }
  }
`;

const LAYOUT_PREVIEW = gql`
  query ($input: EInvoiceLayoutPreviewInput!) {
    eInvoiceLayoutPreview(input: $input) {
      pdf
    }
  }
`;

const CREATE_CHANNEL = gql`
  mutation ($input: CreateChannelInput!) {
    createChannel(input: $input) {
      ... on Channel {
        id
      }
      ... on ErrorResult {
        message
      }
    }
  }
`;

const VOID = gql`
  mutation ($id: ID!, $reason: String!) {
    voidEInvoice(id: $id, reason: $reason) {
      ...EInvoiceFields
      voidReason
    }
  }
  ${E_INVOICE_FIELDS}
`;

const year = new Date().getFullYear();
const no = (n: number) => `RE-${year}-${String(n).padStart(5, '0')}`;
const issued = (invoices: InvoiceResult[]) => invoices.length > 0 && invoices.every((i) => i.status === 'ISSUED');
const errorOf = (p: Promise<unknown>) => p.then(() => 'no error').catch((e: Error) => e.message);

describe('Admin API', () => {
  const pdfStrategy = new FlakyPdfStrategy();
  const { server, adminClient, shopClient } = createTestEnvironment(createConfig({ pdfStrategy }));
  const orders: { id: string; code: string }[] = [];

  beforeAll(async () => {
    await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 1 });
    await adminClient.asSuperAdmin();
  });

  afterAll(async () => {
    await server.destroy();
  });

  it('reports what is missing before e-invoicing can start', async () => {
    const { eInvoiceSetupStatus } = await adminClient.query(SETUP_STATUS);
    const codes = eInvoiceSetupStatus.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['NOT_ENABLED', 'SELLER_INCOMPLETE', 'SELLER_TAX_ID_MISSING', 'TAX_CATEGORY_MISSING']));
    const taxIssue = eInvoiceSetupStatus.find((i: { code: string }) => i.code === 'TAX_CATEGORY_MISSING');
    expect(taxIssue.path).toMatch(/^taxRate:/);
    expect(taxIssue.message).toContain('Zero');
  });

  it('saves typed settings and drops cleared fields', async () => {
    const { updateEInvoiceChannelSettings } = await adminClient.query(UPDATE, {
      input: { ...SELLER_SETTINGS, seller: { ...SELLER_SETTINGS.seller, tradingName: '', legalRegistration: { id: 'HRB 12345' } } },
    });
    expect(updateEInvoiceChannelSettings).toMatchObject({
      enabled: true,
      seller: {
        name: 'Demo Shop GmbH',
        tradingName: null,
        address: { city: 'Berlin', countryCode: 'DE' },
        bank: { iban: 'DE02120300000000202051' },
        legalRegistration: { id: 'HRB 12345' },
      },
      payment: { termDays: 14 },
    });

    const { eInvoiceSetupStatus } = await adminClient.query(SETUP_STATUS);
    // one 0 % rate per zone, all without a VAT category
    expect([...new Set(eInvoiceSetupStatus.map((i: { code: string }) => i.code))]).toEqual(['TAX_CATEGORY_MISSING']);
  });

  it('previews the invoice of an order without saving it or using a number', async () => {
    await adminClient.query(UPDATE, { input: { autoIssue: false } });
    const order = await placeOrder(shopClient, { items: [{ sku: 'KAF-500', quantity: 1 }] });
    orders.push(order);

    const { eInvoicePreview } = await adminClient.query(PREVIEW, { orderId: order.id });
    expect(eInvoicePreview.issues).toEqual([]);
    expect(eInvoicePreview.pdf).toMatch(/^data:application\/pdf;base64,/);
    const pdf = Buffer.from(eInvoicePreview.pdf.split(',')[1], 'base64');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    const { eInvoices } = await adminClient.query(LIST);
    expect(eInvoices.totalItems).toBe(0);
    const { createEInvoice } = await adminClient.query(CREATE_INVOICE, { orderId: order.id });
    expect(createEInvoice.number).toBe(no(1));
    await waitForInvoices(adminClient, order.id, issued);
  });

  it('lists the problems that would block an invoice in the preview', async () => {
    const order = await placeOrder(shopClient, { items: [{ sku: 'GIFT-1', quantity: 1 }] });
    orders.push(order);
    const { eInvoicePreview } = await adminClient.query(PREVIEW, { orderId: order.id });
    expect(eInvoicePreview.issues.map((i: { code: string }) => i.code)).toContain('TAX_CATEGORY_MISSING');
  });

  it('does not preview or invoice orders of another channel', async () => {
    const { createChannel } = await adminClient.query(CREATE_CHANNEL, {
      input: {
        code: 'other-channel',
        token: 'other-channel-token',
        defaultLanguageCode: 'en',
        defaultCurrencyCode: 'EUR',
        pricesIncludeTax: true,
        defaultShippingZoneId: '1',
        defaultTaxZoneId: '1',
      },
    });
    expect(createChannel).toMatchObject({ id: expect.any(String) });
    adminClient.setChannelToken('other-channel-token');
    try {
      expect(await errorOf(adminClient.query(PREVIEW, { orderId: orders[0].id }))).toContain('not found');
      expect(await errorOf(adminClient.query(LAYOUT_PREVIEW, { input: { orderId: orders[0].id } }))).toContain('not found');
      expect(await errorOf(adminClient.query(CREATE_INVOICE, { orderId: orders[0].id }))).toContain('not found');
    } finally {
      adminClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
    }
  });

  it('voids a failed invoice with a reason, keeping its number', async () => {
    pdfStrategy.failing = true;
    const order = await placeOrder(shopClient, { items: [{ sku: 'BOOK-1', quantity: 1 }] });
    orders.push(order);
    await adminClient.query(CREATE_INVOICE, { orderId: order.id });
    const [failed] = await waitForInvoices(adminClient, order.id, (i) => i[0]?.status === 'FAILED');
    expect(failed.errorMessage).toContain('Template exploded');

    expect(await errorOf(adminClient.query(VOID, { id: failed.id, reason: '  ' }))).toContain('reason is required');
    const { voidEInvoice } = await adminClient.query(VOID, { id: failed.id, reason: 'Template bug, replaced by a new invoice' });
    expect(voidEInvoice).toMatchObject({ status: 'VOID', number: no(2), voidReason: 'Template bug, replaced by a new invoice' });
    pdfStrategy.failing = false;

    const [first] = await waitForInvoices(adminClient, orders[0].id, issued);
    expect(await errorOf(adminClient.query(VOID, { id: first.id, reason: 'x' }))).toContain('only FAILED');
  });

  it('lists invoices with filters on type, status and order code', async () => {
    const all = (await adminClient.query(LIST)).eInvoices;
    expect(all.totalItems).toBe(2);
    // newest first
    expect(all.items.map((i: InvoiceResult) => i.number)).toEqual([no(2), no(1)]);
    expect(all.items[1]).toMatchObject({ orderCode: orders[0].code, order: { id: orders[0].id, code: orders[0].code } });

    const byStatus = (await adminClient.query(LIST, { options: { filter: { status: { eq: 'ISSUED' } } } })).eInvoices;
    expect(byStatus.items.map((i: InvoiceResult) => i.number)).toEqual([no(1)]);

    const byCode = (await adminClient.query(LIST, { options: { filter: { orderCode: { eq: orders[2].code } } } })).eInvoices;
    expect(byCode.items.map((i: InvoiceResult) => i.number)).toEqual([no(2)]);

    const invoices = (await adminClient.query(LIST, { options: { filter: { type: { eq: 'INVOICE' } } } })).eInvoices;
    expect(invoices.totalItems).toBe(2);
    const notes = (await adminClient.query(LIST, { options: { filter: { type: { in: ['CREDIT_NOTE'] } } } })).eInvoices;
    expect(notes.totalItems).toBe(0);

    const sorted = (await adminClient.query(LIST, { options: { sort: { number: 'ASC' }, take: 1 } })).eInvoices;
    expect(sorted).toMatchObject({ totalItems: 2, items: [{ number: no(1) }] });
  });

  // sql.js cannot run two transactions at the same time
  it.runIf(usePostgres)('renders a document only once when two renders run at the same time', async () => {
    pdfStrategy.failing = true;
    const order = await placeOrder(shopClient, { items: [{ sku: 'BOOK-1', quantity: 1 }] });
    await adminClient.query(CREATE_INVOICE, { orderId: order.id });
    const [failed] = await waitForInvoices(adminClient, order.id, (i) => i[0]?.status === 'FAILED');
    pdfStrategy.failing = false;

    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    const renderer = server.app.get(InvoiceRenderService);
    // The test config encodes ids in the API (T_3)
    const id = failed.id.replace(/^T_/, '');
    await Promise.all([renderer.render(ctx, id), renderer.render(ctx, id)]);
    const [invoice] = await waitForInvoices(adminClient, order.id, issued);
    expect(invoice.files).toHaveLength(1);
  });
});
