import { RequestContext } from '@vendure/core';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { LocalFileInvoiceStorageStrategy, safeKey } from '../../src';

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
