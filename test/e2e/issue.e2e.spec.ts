import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../fixtures/initial-data';
import { createConfig, fixtures } from '../helpers';
import { extractFacturX } from '../pdf-utils';

import {
  CREATE_INVOICE,
  InvoiceResult,
  ORDER_INVOICES,
  placeOrder,
  readFiles,
  RETRY_INVOICE,
  SELLER_SETTINGS,
  UPDATE_SETTINGS,
  waitForInvoices,
  writeOutput,
} from './helpers';

const year = new Date().getFullYear();
const no = (n: number) => `RE-${year}-${String(n).padStart(5, '0')}`;
const issued = (invoices: InvoiceResult[]) => invoices.length > 0 && invoices.every((i) => i.status === 'ISSUED');

describe('Issuing invoices', () => {
  const { server, adminClient, shopClient } = createTestEnvironment(createConfig());
  let unconfiguredOrder: { id: string; code: string };
  let autoOrder: { id: string; code: string };

  beforeAll(async () => {
    await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 1 });
    await adminClient.asSuperAdmin();
  });

  afterAll(async () => {
    await server.destroy();
  });

  it('does nothing while e-invoicing is not enabled for the channel', async () => {
    unconfiguredOrder = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 }] });
    await new Promise((r) => setTimeout(r, 500));
    const { order } = await adminClient.query(ORDER_INVOICES, { id: unconfiguredOrder.id });
    expect(order.state).toBe('PaymentSettled');
    expect(order.eInvoices).toEqual([]);
  });

  it('saves the channel settings', async () => {
    const { updateEInvoiceChannelSettings } = await adminClient.query(UPDATE_SETTINGS, { input: SELLER_SETTINGS });
    expect(updateEInvoiceChannelSettings.enabled).toBe(true);
    expect(updateEInvoiceChannelSettings.seller.name).toBe('Demo Shop GmbH');
  });

  it('issues an invoice automatically when the payment is settled', async () => {
    autoOrder = await placeOrder(shopClient, {
      items: [
        { sku: 'KAF-500', quantity: 2 },
        { sku: 'BOOK-1', quantity: 1 },
      ],
      customFields: { eInvoiceVatId: 'DE987654321', eInvoicePurchaseOrder: 'PO-4711' },
    });
    const [invoice] = await waitForInvoices(adminClient, autoOrder.id, issued);
    const { order } = await adminClient.query(ORDER_INVOICES, { id: autoOrder.id });

    expect(invoice).toMatchObject({
      type: 'INVOICE',
      status: 'ISSUED',
      reason: 'auto',
      number: no(1),
      formats: ['ZUGFERD'],
      totalWithTax: order.totalWithTax,
      issues: [],
    });
    // 2 × 10.00 + 18.69 net, shipping 4.90 net (19 %)
    expect(invoice.totalNet).toBe(2000 + 1869 + 490);
    expect(invoice.files).toHaveLength(1);
    expect(invoice.files[0]).toMatchObject({ format: 'ZUGFERD', mimeType: 'application/pdf', fileName: `${no(1)}.pdf` });
    expect(invoice.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);

    const files = await readFiles(server, no(1));
    writeOutput('auto-b2b.pdf', files.zugferd);
    const xml = extractFacturX(files.zugferd);
    expect(xml).toContain(`<ram:ID>${no(1)}</ram:ID>`);
    expect(xml).toContain('<ram:Name>Beispiel Kunde AG</ram:Name>');
    expect(xml).toContain('<ram:ID schemeID="VA">DE987654321</ram:ID>');
    expect(xml).toContain(`<ram:IssuerAssignedID>${autoOrder.code}</ram:IssuerAssignedID>`);
    expect(xml).toContain('<ram:IssuerAssignedID>PO-4711</ram:IssuerAssignedID>');
    expect(xml).toContain('<ram:Reason>DHL Paket</ram:Reason>');
    expect(xml).toContain('<ram:DuePayableAmount>0.00</ram:DuePayableAmount>');
  });

  it('does not issue a second invoice for the same order', async () => {
    const { createEInvoice } = await adminClient
      .query(CREATE_INVOICE, { orderId: autoOrder.id })
      .catch((e: Error) => ({ createEInvoice: e.message }));
    expect(createEInvoice).toContain(`already has invoice ${no(1)}`);
  });

  it('creates an invoice manually', async () => {
    const { createEInvoice } = await adminClient.query(CREATE_INVOICE, { orderId: unconfiguredOrder.id });
    expect(createEInvoice).toMatchObject({ status: 'PENDING', reason: 'manual', number: no(2) });
    const [invoice] = await waitForInvoices(adminClient, unconfiguredOrder.id, issued);
    expect(invoice.number).toBe(no(2));
  });

  it('blocks an invoice with missing data without consuming a number, and issues it after the fix', async () => {
    const order = await placeOrder(shopClient, { items: [{ sku: 'GIFT-1', quantity: 1 }] });
    const [blocked] = await waitForInvoices(adminClient, order.id, (i) => i[0]?.status === 'BLOCKED');
    expect(blocked.number).toBeNull();
    expect(blocked.files).toEqual([]);
    expect(blocked.issues.map((i) => i.code)).toContain('TAX_CATEGORY_MISSING');

    // Fix: the 0 % tax rate gets the category "zero rated"
    const { taxRates } = await adminClient.query(gql`
      query {
        taxRates {
          items {
            id
            value
          }
        }
      }
    `);
    const zero = taxRates.items.find((t: { value: number }) => t.value === 0);
    await adminClient.query(
      gql`
        mutation ($input: UpdateTaxRateInput!) {
          updateTaxRate(input: $input) {
            id
          }
        }
      `,
      { input: { id: zero.id, customFields: { eInvoiceCategoryCode: 'Z' } } },
    );

    const { retryEInvoice } = await adminClient.query(RETRY_INVOICE, { id: blocked.id });
    expect(retryEInvoice).toMatchObject({ id: blocked.id, status: 'PENDING', number: no(3), issues: [] });
    await waitForInvoices(adminClient, order.id, issued);
  });

  it('adds an XRechnung when the buyer has a Leitweg-ID', async () => {
    const order = await placeOrder(shopClient, {
      items: [{ sku: 'KAF-500', quantity: 1 }],
      customFields: { eInvoiceLeitwegId: '04011000-1234512345-06' },
    });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued);
    expect(invoice.formats).toEqual(['ZUGFERD', 'XRECHNUNG_CII']);
    expect(invoice.files.map((f) => f.fileName)).toEqual([`${no(4)}.pdf`, `${no(4)}-xrechnung.xml`]);

    const files = await readFiles(server, no(4));
    writeOutput('leitweg.pdf', files.zugferd);
    writeOutput('leitweg.xrechnung-cii.xml', files['xrechnung-cii']);
    const xrechnung = files['xrechnung-cii'].toString('utf8');
    expect(xrechnung).toContain('<ram:BuyerReference>04011000-1234512345-06</ram:BuyerReference>');
    expect(xrechnung).toContain('<ram:URIID schemeID="0204">04011000-1234512345-06</ram:URIID>');
  });

  it('renders the logo and layout texts from the channel settings', async () => {
    const { createAssets } = await adminClient.fileUploadMutation({
      mutation: gql`
        mutation CreateAssets($input: [CreateAssetInput!]!) {
          createAssets(input: $input) {
            ... on Asset {
              id
            }
          }
        }
      `,
      filePaths: [path.join(__dirname, '../fixtures/logo.png')],
      mapVariables: () => ({ input: [{ file: null }] }),
    });
    await adminClient.query(UPDATE_SETTINGS, {
      input: { layout: { logoAssetId: createAssets[0].id, accentColor: '#1a5fb4', introText: 'Vielen Dank für Ihre Bestellung!' } },
    });
    const order = await placeOrder(shopClient, { items: [{ sku: 'BOOK-1', quantity: 1 }] });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued);
    const pdf = (await readFiles(server, invoice.number as string)).zugferd;
    writeOutput('logo.pdf', pdf);
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
  });

  it('numbers concurrently created invoices without gaps or duplicates', async () => {
    await adminClient.query(UPDATE_SETTINGS, { input: { autoIssue: false } });
    const orders = [];
    for (let i = 0; i < 10; i++) {
      orders.push(await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 + i }] }));
    }
    const results = await Promise.all(
      orders.map((o) => adminClient.query(CREATE_INVOICE, { orderId: o.id }).then((r) => r.createEInvoice as InvoiceResult)),
    );
    const numbers = results.map((r) => r.number).sort();
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => no(6 + i)));
    for (const o of orders) await waitForInvoices(adminClient, o.id, issued);
  });
});
