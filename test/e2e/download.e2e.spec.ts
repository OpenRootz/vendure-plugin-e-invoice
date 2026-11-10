import { RequestContext } from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN } from '@vendure/testing';
import { createHash } from 'crypto';
import { unzipSync } from 'fflate';
import gql from 'graphql-tag';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DownloadLinkService } from '../../src';
import { initialData } from '../fixtures/initial-data';
import { createConfig, fixtures } from '../helpers';

import { InvoiceResult, placeOrder, SELLER_SETTINGS, UPDATE_SETTINGS, waitForInvoices } from './helpers';

const FILES = gql`
  query ($id: ID!) {
    order(id: $id) {
      eInvoices {
        id
        number
        status
        files {
          format
          fileName
          sha256
          downloadUrl
        }
      }
    }
  }
`;

const GUEST_LINK = gql`
  mutation ($invoiceId: ID!, $format: EInvoiceFormat) {
    createEInvoiceGuestLink(invoiceId: $invoiceId, format: $format)
  }
`;

const ZIP_LINK = gql`
  mutation ($ids: [ID!]!) {
    createEInvoiceZipLink(ids: $ids)
  }
`;

const SHOP_ORDER = gql`
  query ($code: String!) {
    orderByCode(code: $code) {
      eInvoices {
        id
        type
        number
        issueDate
        totalWithTax
        currencyCode
        files {
          format
          fileName
          mimeType
          downloadUrl
        }
      }
    }
  }
`;

interface FileResult {
  format: string;
  fileName: string;
  sha256: string;
  downloadUrl: string;
}

const issued = (invoices: InvoiceResult[]) => invoices.length > 0 && invoices.every((i) => i.status === 'ISSUED');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function get(url: string) {
  const res = await fetch(url);
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

function withParam(url: string, name: string, value: string) {
  const u = new URL(url);
  u.searchParams.set(name, value);
  return u.toString();
}

describe('Downloads and Shop API', () => {
  const { server, adminClient, shopClient } = createTestEnvironment(createConfig());
  let order: { id: string; code: string };
  let invoice: { id: string; number: string; files: FileResult[] };

  beforeAll(async () => {
    await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 1 });
    await adminClient.asSuperAdmin();
    await adminClient.query(UPDATE_SETTINGS, { input: SELLER_SETTINGS });
    order = await placeOrder(shopClient, {
      items: [{ sku: 'KAF-500', quantity: 1 }],
      customFields: { eInvoiceLeitwegId: '04011000-1234512345-06' },
    });
    await waitForInvoices(adminClient, order.id, issued);
    invoice = (await adminClient.query(FILES, { id: order.id })).order.eInvoices[0];
  });

  afterAll(async () => {
    await server.destroy();
  });

  it('downloads every file through its signed admin link', async () => {
    expect(invoice.files.map((f) => f.format)).toEqual(['ZUGFERD', 'XRECHNUNG_CII']);
    for (const file of invoice.files) {
      const res = await get(file.downloadUrl);
      expect(res.status).toBe(200);
      expect(sha256(res.body)).toBe(file.sha256);
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${file.fileName}"`);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
    const pdf = await get(invoice.files[0].downloadUrl);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
  });

  it('rejects tampered, foreign and expired links', async () => {
    const url = invoice.files[0].downloadUrl;
    expect((await get(withParam(url, 'sig', 'x' + new URL(url).searchParams.get('sig')!.slice(1)))).status).toBe(403);
    expect((await get(withParam(url, 'exp', String(Number(new URL(url).searchParams.get('exp')) + 60)))).status).toBe(403);
    expect((await get(withParam(url, 'f', 'xrechnung-cii'))).status).toBe(403);
    expect((await get(withParam(url, 'f', 'nonsense'))).status).toBe(400);
    expect((await get(url.replace(/\/download\/\d+\?/, '/download/999?'))).status).toBe(404);

    // A correctly signed link whose expiry has passed
    const links = server.app.get(DownloadLinkService);
    const ctx = { channel: { token: E2E_DEFAULT_CHANNEL_TOKEN } } as RequestContext;
    const exp = Math.floor(Date.now() / 1000) - 10;
    // Links carry the internal ID (the e2e ID strategy encodes API IDs as T_1)
    const internalId = /\/download\/(\d+)\?/.exec(url)![1];
    const sig = links.sign(ctx, { kind: 'file', invoiceId: internalId, format: 'zugferd' }, exp);
    const expired = await get(withParam(withParam(url, 'exp', String(exp)), 'sig', sig));
    expect(expired.status).toBe(410);
    expect(expired.body.toString()).toContain('expired');
  });

  it('creates guest links that are valid for 7 days', async () => {
    const { createEInvoiceGuestLink } = await adminClient.query(GUEST_LINK, { invoiceId: invoice.id });
    const exp = Number(new URL(createEInvoiceGuestLink).searchParams.get('exp'));
    expect(exp - Date.now() / 1000).toBeGreaterThan(7 * 86400 - 60);
    const res = await get(createEInvoiceGuestLink);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');

    const xml = await adminClient.query(GUEST_LINK, { invoiceId: invoice.id, format: 'XRECHNUNG_CII' });
    expect((await get(xml.createEInvoiceGuestLink)).body.toString()).toContain('04011000-1234512345-06');
    const missing = await adminClient
      .query(GUEST_LINK, { invoiceId: invoice.id, format: 'XRECHNUNG_UBL' })
      .catch((e: Error) => e.message);
    expect(missing).toContain('has no XRECHNUNG_UBL file');
  });

  it('downloads several invoices as one ZIP archive', async () => {
    const second = await placeOrder(shopClient, { items: [{ sku: 'BOOK-1', quantity: 1 }] });
    const [secondInvoice] = await waitForInvoices(adminClient, second.id, issued);
    const { createEInvoiceZipLink } = await adminClient.query(ZIP_LINK, { ids: [invoice.id, secondInvoice.id] });
    const res = await get(createEInvoiceZipLink);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const entries = unzipSync(res.body);
    expect(Object.keys(entries).sort()).toEqual(
      [...invoice.files.map((f) => f.fileName), `${secondInvoice.number}.pdf`].sort(),
    );
    expect(sha256(Buffer.from(entries[invoice.files[0].fileName]))).toBe(invoice.files[0].sha256);

    const ids = new URL(createEInvoiceZipLink).searchParams.get('ids')!.split(',');
    expect(ids).toHaveLength(2);
    const tampered = withParam(createEInvoiceZipLink, 'ids', ids[0]);
    expect((await get(tampered)).status).toBe(403);

    const tooMany = Array.from({ length: 501 }, () => invoice.id);
    expect(await adminClient.query(ZIP_LINK, { ids: tooMany }).catch((e: Error) => e.message)).toContain('At most 500');
  });

  it('does not create links for documents that are not issued', async () => {
    await adminClient.query(UPDATE_SETTINGS, { input: { autoIssue: true } });
    const blockedOrder = await placeOrder(shopClient, { items: [{ sku: 'GIFT-1', quantity: 1 }] });
    const [blocked] = await waitForInvoices(adminClient, blockedOrder.id, (i) => i[0]?.status === 'BLOCKED');
    const error = await adminClient.query(GUEST_LINK, { invoiceId: blocked.id }).catch((e: Error) => e.message);
    expect(error).toContain('is not issued');
    const zip = await adminClient.query(ZIP_LINK, { ids: [invoice.id, blocked.id] }).catch((e: Error) => e.message);
    expect(zip).toContain('is not issued');

    // The Shop API only shows issued documents
    const { orderByCode } = await shopClient.query(SHOP_ORDER, { code: blockedOrder.code });
    expect(orderByCode.eInvoices).toEqual([]);
  });

  it('lets the customer download their invoice through the Shop API', async () => {
    const own = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 }] });
    const [ownInvoice] = await waitForInvoices(adminClient, own.id, issued);
    const { orderByCode } = await shopClient.query(SHOP_ORDER, { code: own.code });
    expect(orderByCode.eInvoices).toEqual([
      {
        id: ownInvoice.id,
        type: 'INVOICE',
        number: ownInvoice.number,
        issueDate: ownInvoice.issueDate,
        totalWithTax: ownInvoice.totalWithTax,
        currencyCode: ownInvoice.currencyCode,
        files: [{ format: 'ZUGFERD', fileName: `${ownInvoice.number}.pdf`, mimeType: 'application/pdf', downloadUrl: expect.any(String) }],
      },
    ]);
    const url = orderByCode.eInvoices[0].files[0].downloadUrl;
    // owner links live 1 hour
    expect(Number(new URL(url).searchParams.get('exp')) - Date.now() / 1000).toBeLessThanOrEqual(3600);
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');

  });
});
