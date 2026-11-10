import { createTestEnvironment } from '@vendure/testing';
import { createHash } from 'crypto';
import fs from 'fs';
import gql from 'graphql-tag';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalFileInvoiceStorageStrategy } from '../../src';
import { initialData } from '../fixtures/initial-data';
import { createConfig, fixtures } from '../helpers';

import { InvoiceResult, placeOrder, SELLER_SETTINGS, UPDATE_SETTINGS, waitForInvoices } from './helpers';

const DOWNLOAD_URLS = gql`
  query ($id: ID!) {
    order(id: $id) {
      eInvoices {
        files {
          fileName
          sha256
          downloadUrl
        }
      }
    }
  }
`;

describe('Local file storage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-invoice-e2e-'));
  const { server, adminClient, shopClient } = createTestEnvironment(
    createConfig({ storage: new LocalFileInvoiceStorageStrategy({ dir }) }),
  );

  beforeAll(async () => {
    await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 1 });
    await adminClient.asSuperAdmin();
    await adminClient.query(UPDATE_SETTINGS, { input: SELLER_SETTINGS });
  });

  afterAll(async () => {
    await server.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stores issued files in the directory and serves them through the download route', async () => {
    const order = await placeOrder(shopClient, { items: [{ sku: 'KAF-500', quantity: 1 }] });
    const [invoice] = await waitForInvoices(adminClient, order.id, (i: InvoiceResult[]) => i[0]?.status === 'ISSUED');
    const year = invoice.issueDate?.slice(0, 4);
    const onDisk = fs.readFileSync(path.join(dir, `__default_channel__/${year}/${invoice.number}.pdf`));

    const { order: result } = await adminClient.query(DOWNLOAD_URLS, { id: order.id });
    const [file] = result.eInvoices[0].files;
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(file.sha256);
    const res = await fetch(file.downloadUrl);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(onDisk)).toBe(true);
  });
});
