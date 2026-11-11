import { TransactionalConnection } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EInvoiceChannelSettings } from '../../src';
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
      blocks {
        key
        page
        x
        y
        w
        h
        overflowBy
      }
      layoutIssues {
        level
        code
        message
        blockKey
      }
    }
  }
`;

const LAYOUT = gql`
  query {
    eInvoiceChannelSettings {
      layout {
        logoAssetId
        accentColor
        introText
        footerText
        document
      }
    }
  }
`;

const SAVE_LAYOUT = gql`
  mutation ($input: UpdateEInvoiceChannelSettingsInput!) {
    updateEInvoiceChannelSettings(input: $input) {
      layout {
        accentColor
        introText
        document
      }
    }
  }
`;

const DEFAULT_LAYOUT = gql`
  query ($preset: EInvoiceLayoutPreset) {
    eInvoiceDefaultLayout(preset: $preset)
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

const ORDER_PREVIEW = gql`
  query ($orderId: ID!) {
    eInvoicePreview(orderId: $orderId) {
      pdf
    }
  }
`;

const INVOICE_WITH_ORDER = gql`
  query ($id: ID!) {
    eInvoice(id: $id) {
      id
      orderCode
      order {
        id
        code
      }
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
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, {
      input: { seller, payment, sample: 'MANY_LINES', language: 'en' },
    });
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
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, {
      input: { orderId: order.id, layout: { closingText: 'Bye' } },
    });
    expect(eInvoiceLayoutPreview.issues).toEqual([]);
    expect(eInvoiceLayoutPreview.pageCount).toBe(1);

    // nothing was stored and no number was used
    expect((await adminClient.query(COUNT)).eInvoices.totalItems).toBe(0);
    const { createEInvoice } = await adminClient.query(CREATE_INVOICE, { orderId: order.id });
    expect(createEInvoice.number).toBe(`RE-${new Date().getFullYear()}-00001`);
  });

  it('rejects texts longer than 2000 characters on preview and on save', async () => {
    const layout = { introText: 'x'.repeat(2001) };
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: { layout } });
    expect(eInvoiceLayoutPreview.pdf).toBeNull();
    expect(eInvoiceLayoutPreview.layoutIssues[0].message).toContain('longer than 2000');
    expect(await errorOf(adminClient.query(UPDATE_SETTINGS, { input: { layout } }))).toContain('longer than 2000');
    const ok = await adminClient.query(LAYOUT_PREVIEW, { input: { layout: { introText: 'x'.repeat(2000) } } });
    expect(ok.eInvoiceLayoutPreview.pdf).toBeTruthy();
  });

  it('returns where the blocks ended up and the layout issues', async () => {
    const { eInvoiceDefaultLayout: document } = await adminClient.query(DEFAULT_LAYOUT);
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: { layout: { document } } });
    expect(eInvoiceLayoutPreview.layoutIssues).toEqual([]);
    const ids = eInvoiceLayoutPreview.blocks.map((b: { key: string }) => b.key);
    expect(ids).toEqual(expect.arrayContaining(['recipient', 'details', 'title', 'lines', 'totals', 'footer']));
    expect(eInvoiceLayoutPreview.blocks.find((b: { key: string }) => b.key === 'recipient')).toMatchObject({ page: 1, x: 198, y: 478 });

    // a too small address field: clipped in the worst case (error), fitted in the preview of the sample
    const small = {
      ...document,
      blocks: document.blocks.map((b: { key: string }) =>
        b.key === 'recipient' ? { ...b, frame: { x: 198, y: 478, w: 878, h: 120 } } : b,
      ),
    };
    const clipped = (await adminClient.query(LAYOUT_PREVIEW, { input: { layout: { document: small } } })).eInvoiceLayoutPreview;
    expect(clipped.pdf).toBeTruthy();
    expect(clipped.layoutIssues.filter((i: { level: string }) => i.level === 'error')).toEqual([
      expect.objectContaining({ code: 'CLIPPED', blockKey: 'recipient' }),
    ]);
    expect(await errorOf(adminClient.query(SAVE_LAYOUT, { input: { layout: { document: small } } }))).toContain(
      'does not fit into its frame',
    );
  });

  it('saves a larger base font: the fixed blocks fit with a reduced font', async () => {
    const { eInvoiceDefaultLayout: document } = await adminClient.query(DEFAULT_LAYOUT);
    const larger = { ...document, theme: { ...document.theme, fontSize: 11 } };
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: { layout: { document: larger } } });
    expect(eInvoiceLayoutPreview.layoutIssues.filter((i: { level: string }) => i.level === 'error')).toEqual([]);
    expect(eInvoiceLayoutPreview.layoutIssues.map((i: { code: string }) => i.code)).toContain('FONT_REDUCED');
    const { updateEInvoiceChannelSettings } = await adminClient.query(SAVE_LAYOUT, { input: { layout: { document: larger } } });
    expect(updateEInvoiceChannelSettings.layout.document.theme.fontSize).toBe(11);
  });

  it('offers the configured fonts and handles an unknown font without breaking the preview', async () => {
    const { eInvoiceLayoutFonts } = await adminClient.query(gql`
      query {
        eInvoiceLayoutFonts
      }
    `);
    expect(eInvoiceLayoutFonts).toEqual(['Roboto']);
    const { eInvoiceDefaultLayout: document } = await adminClient.query(DEFAULT_LAYOUT);
    const arial = { ...document, theme: { ...document.theme, font: 'Arial' } };
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: { layout: { document: arial } } });
    expect(eInvoiceLayoutPreview.pdf).toBeTruthy();
    expect(eInvoiceLayoutPreview.layoutIssues).toEqual([expect.objectContaining({ level: 'error', code: 'UNKNOWN_FONT' })]);
    expect(await errorOf(adminClient.query(SAVE_LAYOUT, { input: { layout: { document: arial } } }))).toContain(
      '"Arial" is not configured',
    );
  });

  it('rejects a layout without the delivery date row', async () => {
    const { eInvoiceDefaultLayout: document } = await adminClient.query(DEFAULT_LAYOUT);
    const noDate = {
      ...document,
      blocks: document.blocks.map((b: { key: string }) => (b.key === 'details' ? { ...b, props: { fields: ['number', 'issueDate'] } } : b)),
    };
    expect(await errorOf(adminClient.query(SAVE_LAYOUT, { input: { layout: { document: noDate } } }))).toContain(
      'No visible block prints: Delivery date',
    );
  });

  it('saves layout documents and rejects invalid ones', async () => {
    const { eInvoiceDefaultLayout: document } = await adminClient.query(DEFAULT_LAYOUT, { preset: 'DIN_5008_B' });
    expect(document.windowEnvelope).toBe('B');
    const { updateEInvoiceChannelSettings } = await adminClient.query(SAVE_LAYOUT, { input: { layout: { document, introText: 'Hallo' } } });
    expect(updateEInvoiceChannelSettings.layout).toMatchObject({
      introText: 'Hallo',
      accentColor: '#333333',
      document: { windowEnvelope: 'B' },
    });

    const hidden = {
      ...document,
      blocks: document.blocks.map((b: { type: string }) => (b.type === 'totals' ? { ...b, visible: false } : b)),
    };
    expect(await errorOf(adminClient.query(SAVE_LAYOUT, { input: { layout: { document: hidden } } }))).toContain('No visible block prints');
    const broken = { ...document, blocks: [...document.blocks, { ...document.blocks[0] }] };
    expect(await errorOf(adminClient.query(SAVE_LAYOUT, { input: { layout: { document: broken } } }))).toContain('is used twice');
    expect((await adminClient.query(LAYOUT)).eInvoiceChannelSettings.layout.document.windowEnvelope).toBe('B');
  });

  it('decodes the asset IDs of image blocks and encodes them again when read', async () => {
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
    const assetId = createAssets[0].id as string;
    // The test server encodes IDs ("T_1"); the document is JSON, so Vendure's ID codec does not decode it
    expect(assetId).toMatch(/^T_/);
    const { eInvoiceDefaultLayout: base } = await adminClient.query(DEFAULT_LAYOUT);
    const withImage = (id: string) => ({
      ...base,
      blocks: [
        ...base.blocks,
        {
          key: 'img',
          type: 'image',
          visible: true,
          pages: 'first',
          frame: { x: 1200, y: 2600, w: 300, h: 150 },
          overflow: 'fixed',
          props: { assetId: id },
        },
      ],
    });

    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: { layout: { document: withImage(assetId) } } });
    expect(eInvoiceLayoutPreview.issues.map((i: { code: string }) => i.code)).not.toContain('LOGO_NOT_FOUND');
    expect(bytes(eInvoiceLayoutPreview.pdf).toString('latin1')).toContain('/Subtype /Image');

    const { updateEInvoiceChannelSettings } = await adminClient.query(SAVE_LAYOUT, { input: { layout: { document: withImage(assetId) } } });
    const saved = updateEInvoiceChannelSettings.layout.document.blocks.find((b: { key: string }) => b.key === 'img');
    expect(saved.props.assetId).toBe(assetId);
    const connection = server.app.get(TransactionalConnection);
    const row = await connection.rawConnection.getRepository(EInvoiceChannelSettings).findOneByOrFail({ channelId: 1 });
    expect(String(row.layout.blocks.find((b) => b.key === 'img')!.props!.assetId)).toBe(assetId.replace('T_', ''));

    // Malformed IDs must not reach the database: the preview renders without the image, saving keeps working
    const missing = await adminClient.query(LAYOUT_PREVIEW, { input: { layout: { document: withImage('not-an-id') } } });
    expect(missing.eInvoiceLayoutPreview.issues.map((i: { code: string }) => i.code)).toContain('LOGO_NOT_FOUND');
    await adminClient.query(SAVE_LAYOUT, { input: { layout: { document: withImage('not-an-id') } } });
  });

  it('converts v1 layouts when they are read', async () => {
    const connection = server.app.get(TransactionalConnection);
    await connection.rawConnection
      .getRepository(EInvoiceChannelSettings)
      .update({ channelId: 1 }, { layout: { accentColor: '#1a5fb4', introText: 'Alt', footerText: 'Fuß' } as never });
    const { layout } = (await adminClient.query(LAYOUT)).eInvoiceChannelSettings;
    expect(layout).toMatchObject({ accentColor: '#1a5fb4', introText: 'Alt', footerText: 'Fuß', document: { version: 2 } });
    const footer = layout.document.blocks.find((b: { key: string }) => b.key === 'footer');
    expect(footer.props).toMatchObject({ text: 'Fuß', pageNumber: true });
    const { eInvoiceLayoutPreview } = await adminClient.query(LAYOUT_PREVIEW, { input: {} });
    expect(eInvoiceLayoutPreview.pdf).toBeTruthy();
  });

  it('does not expose orders to users without the ReadOrder permission', async () => {
    const order = await placeOrder(shopClient, { items: [{ sku: 'KAF-500', quantity: 1 }] });
    const { createEInvoice } = await adminClient.query(CREATE_INVOICE, { orderId: order.id });
    const { createRole } = await adminClient.query(CREATE_ROLE, {
      input: { code: 'invoices-only', description: 'Invoices only', permissions: ['ReadEInvoice'], channelIds: ['1'] },
    });
    await adminClient.query(CREATE_ADMIN, {
      input: { firstName: 'Only', lastName: 'Invoices', emailAddress: 'invonly@example.com', password: 'secret', roleIds: [createRole.id] },
    });
    await adminClient.asUserWithCredentials('invonly@example.com', 'secret');
    try {
      const forbidden = /not currently authorized/;
      expect(await errorOf(adminClient.query(LAYOUT_PREVIEW, { input: { orderId: order.id } }))).toMatch(forbidden);
      expect(await errorOf(adminClient.query(ORDER_PREVIEW, { orderId: order.id }))).toMatch(forbidden);
      // Sample data and the invoice itself stay readable; the order is not
      expect((await adminClient.query(LAYOUT_PREVIEW, { input: {} })).eInvoiceLayoutPreview.pdf).toBeTruthy();
      const { eInvoice } = await adminClient.query(INVOICE_WITH_ORDER, { id: createEInvoice.id });
      expect(eInvoice).toMatchObject({ id: createEInvoice.id, orderCode: order.code, order: null });
    } finally {
      await adminClient.asSuperAdmin();
    }
    const { eInvoice } = await adminClient.query(INVOICE_WITH_ORDER, { id: createEInvoice.id });
    expect(eInvoice.order).toEqual({ id: order.id, code: order.code });
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
