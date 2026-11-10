import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../fixtures/initial-data';
import { createConfig, fixtures } from '../helpers';

import { CREATE_INVOICE, placeOrder, SELLER_SETTINGS, UPDATE_SETTINGS } from './helpers';

const LAYOUT_PREVIEW = gql`
  query ($input: EInvoiceLayoutPreviewInput!) {
    eInvoiceLayoutPreview(input: $input) {
      pdf
      pageCount
      issues {
        code
        message
        path
      }
    }
  }
`;

const COUNT = gql`
  query {
    eInvoices {
      totalItems
    }
  }
`;

const CREATE_ROLE = gql`
  mutation ($input: CreateRoleInput!) {
    createRole(input: $input) {
      id
    }
  }
`;

const CREATE_ADMIN = gql`
  mutation ($input: CreateAdministratorInput!) {
    createAdministrator(input: $input) {
      id
    }
  }
`;

const { seller, payment } = SELLER_SETTINGS;
const bytes = (dataUrl: string) => Buffer.from(dataUrl.split(',')[1], 'base64');
const errorOf = (p: Promise<unknown>) => p.then(() => 'no error').catch((e: Error) => e.message);

describe('Layout preview', () => {
  const { server, adminClient, shopClient } = createTestEnvironment(createConfig());

  beforeAll(async () => {
    await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 1 });
    await adminClient.asSuperAdmin();
  });

  afterAll(async () => {
    await server.destroy();
  });

  it('renders sample data from unsaved seller data, without any order or saved settings', async () => {
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: { seller, payment } });
    expect(eInvoiceLayoutPreview.issues).toEqual([]);
    expect(eInvoiceLayoutPreview.pageCount).toBe(1);
    const pdf = bytes(eInvoiceLayoutPreview.pdf);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('factur-x.xml');
  });

  it('reports incomplete seller data while typing', async () => {
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: { seller: { name: 'Demo' } } });
    expect(eInvoiceLayoutPreview.issues.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(['SELLER_INCOMPLETE', 'SELLER_TAX_ID_MISSING']),
    );
    expect(eInvoiceLayoutPreview.pdf).toMatch(/^data:application\/pdf/);
  });

  it('renders every sample and breaks long invoices across pages', async () => {
    for (const sample of ['B2B_NET', 'B2C_GROSS', 'CREDIT_NOTE', 'WORST_CASE']) {
      const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: { seller, payment, sample } });
      expect(eInvoiceLayoutPreview.issues, sample).toEqual([]);
      expect(eInvoiceLayoutPreview.pdf, sample).toBeTruthy();
    }
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: { seller, payment, sample: 'MANY_LINES', language: 'en' } });
    expect(eInvoiceLayoutPreview.pageCount).toBeGreaterThan(1);
  });

  it('uses the draft layout instead of the saved one', async () => {
    await adminClient.query(UPDATE_SETTINGS, { input: { ...SELLER_SETTINGS, autoIssue: false, layout: { introText: 'Saved intro' } } });
    const saved = (await adminClient.query(LAYOUT_PREVIEW, { input: {} })).eInvoiceLayoutPreview;
    const draft = (await adminClient.query(LAYOUT_PREVIEW, { input: { layout: { introText: 'Draft intro', accentColor: '#aa0000' } } }))
      .eInvoiceLayoutPreview;
    const savedAgain = (await adminClient.query(LAYOUT_PREVIEW, { input: { layout: { introText: 'Saved intro' } } })).eInvoiceLayoutPreview;
    expect(bytes(draft.pdf).equals(bytes(saved.pdf))).toBe(false);
    // deterministic: the draft equal to the saved layout renders the same bytes
    expect(bytes(savedAgain.pdf).equals(bytes(saved.pdf))).toBe(true);
  });

  it('renders an order with the draft layout', async () => {
    const order = await placeOrder(shopClient, { items: [{ sku: 'KAF-500', quantity: 1 }] });
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: { orderId: order.id, layout: { closingText: 'Bye' } } });
    expect(eInvoiceLayoutPreview.issues).toEqual([]);
    expect(eInvoiceLayoutPreview.pageCount).toBe(1);

    // nothing was stored and no number was used
    expect((await adminClient.query(COUNT)).eInvoices.totalItems).toBe(0);
    const { createEInvoice } = await adminClient.query(CREATE_INVOICE, { orderId: order.id });
    expect(createEInvoice.number).toBe(`RE-${new Date().getFullYear()}-00001`);
  });

  it('rejects texts longer than 2000 characters on preview and on save', async () => {
    const layout = { introText: 'x'.repeat(2001) };
    expect(await errorOf(adminClient.query(LAYOUT_PREVIEW, { input: { layout } }))).toContain('longer than 2000');
    expect(await errorOf(adminClient.query(UPDATE_SETTINGS, { input: { layout } }))).toContain('longer than 2000');
    expect(await errorOf(adminClient.query(LAYOUT_PREVIEW, { input: { layout: { introText: 'x'.repeat(2000) } } }))).toBe('no error');
  });

  it('requires the ReadEInvoice permission', async () => {
    const { createRole } = await adminClient.query(CREATE_ROLE, {
      input: { code: 'no-invoices', description: 'No invoices', permissions: ['ReadOrder'], channelIds: ['1'] },
    });
    await adminClient.query(CREATE_ADMIN, {
      input: { firstName: 'No', lastName: 'Invoices', emailAddress: 'noinv@example.com', password: 'secret', roleIds: [createRole.id] },
    });
    await adminClient.asUserWithCredentials('noinv@example.com', 'secret');
    expect(await errorOf(adminClient.query(LAYOUT_PREVIEW, { input: {} }))).toMatch(/not currently authorized/);
    await adminClient.asSuperAdmin();
  });
});
