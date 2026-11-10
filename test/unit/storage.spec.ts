import { RequestContext } from '@vendure/core';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { LocalFileInvoiceStorageStrategy, S3ClientLike, S3InvoiceStorageStrategy, safeKey } from '../../src';

const ctx = {} as RequestContext;
const file = (key: string, content: string) => ({ key, data: Buffer.from(content), mimeType: 'application/pdf', channelId: 1 });

describe('safeKey', () => {
  it('keeps safe relative paths and rejects traversal', () => {
    expect(safeKey('default/2026/RE-2026-00001.pdf')).toBe('default/2026/RE-2026-00001.pdf');
    expect(safeKey('my shop/2026/a b.pdf')).toBe('my_shop/2026/a_b.pdf');
    expect(() => safeKey('../etc/passwd')).toThrow(/Invalid/);
    expect(() => safeKey('/abs/path')).toThrow(/Invalid/);
    expect(() => safeKey('a//b')).toThrow(/Invalid/);
  });
});

describe('LocalFileInvoiceStorageStrategy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e-invoice-storage-'));
  const storage = new LocalFileInvoiceStorageStrategy({ dir });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stores and reads files below the directory', async () => {
    await storage.init();
    const id = await storage.save(ctx, file('default/2026/RE-1.pdf', 'one'));
    expect(id).toBe('default/2026/RE-1.pdf');
    expect(fs.readFileSync(path.join(dir, 'default/2026/RE-1.pdf'), 'utf8')).toBe('one');
    expect((await storage.read(ctx, id)).toString()).toBe('one');
  });

  it('never overwrites a file', async () => {
    expect(await storage.save(ctx, file('default/2026/RE-1.pdf', 'one'))).toBe('default/2026/RE-1.pdf');
    const other = await storage.save(ctx, file('default/2026/RE-1.pdf', 'two'));
    expect(other).toMatch(/^default\/2026\/RE-1\.[0-9a-f]{12}\.pdf$/);
    expect((await storage.read(ctx, 'default/2026/RE-1.pdf')).toString()).toBe('one');
    expect((await storage.read(ctx, other)).toString()).toBe('two');
    expect(await storage.save(ctx, file('default/2026/RE-1.pdf', 'two'))).toBe(other);
  });

  it('refuses keys outside the directory', async () => {
    await expect(storage.read(ctx, '../outside')).rejects.toThrow(/Invalid/);
  });
});

/** In-memory bucket that understands the commands the strategy sends. */
class FakeS3 implements S3ClientLike {
  objects = new Map<string, { body: Buffer; input: Record<string, unknown> }>();
  async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const { input } = command;
    const key = `${input.Bucket}/${input.Key}`;
    if (command.constructor.name === 'PutObjectCommand') {
      if (input.IfNoneMatch === '*' && this.objects.has(key)) {
        throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      }
      this.objects.set(key, { body: input.Body as Buffer, input });
      return {};
    }
    const object = this.objects.get(key);
    if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return { Body: { transformToByteArray: async () => new Uint8Array(object.body) } };
  }
}

describe('S3InvoiceStorageStrategy', () => {
  const client = new FakeS3();
  const storage = new S3InvoiceStorageStrategy({ bucket: 'invoices', prefix: 'shop/', client, serverSideEncryption: 'AES256' });
  storage.init();

  it('puts objects with content type, checksum, encryption and without overwriting', async () => {
    const id = await storage.save(ctx, file('default/2026/RE-1.pdf', 'one'));
    expect(id).toBe('shop/default/2026/RE-1.pdf');
    expect(client.objects.get('invoices/shop/default/2026/RE-1.pdf')?.input).toMatchObject({
      ContentType: 'application/pdf',
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: expect.any(String),
    });
    expect((await storage.read(ctx, id)).toString()).toBe('one');
  });

  it('reuses identical objects and stores different content beside them', async () => {
    expect(await storage.save(ctx, file('default/2026/RE-1.pdf', 'one'))).toBe('shop/default/2026/RE-1.pdf');
    const other = await storage.save(ctx, file('default/2026/RE-1.pdf', 'two'));
    expect(other).toMatch(/^shop\/default\/2026\/RE-1\.[0-9a-f]{12}\.pdf$/);
    expect((await storage.read(ctx, 'shop/default/2026/RE-1.pdf')).toString()).toBe('one');
  });

  it('requires a bucket', () => {
    expect(() => new S3InvoiceStorageStrategy({ bucket: '' })).toThrow(/bucket/);
  });
});
