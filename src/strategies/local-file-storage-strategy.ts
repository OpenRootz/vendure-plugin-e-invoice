import { RequestContext } from '@vendure/core';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import { InvoiceStorageStrategy, StoredFileInput } from './types';

/**
 * Options of the {@link LocalFileInvoiceStorageStrategy}.
 *
 * @category Strategies
 */
export interface LocalFileInvoiceStorageOptions {
  /**
   * Directory for the files. Must not be served publicly (in particular not the AssetServerPlugin's asset dir),
   * and server and worker must share it.
   */
  dir: string;
}

/**
 * Stores the files in a local directory, as `<dir>/<channel>/<year>/<file name>`. Files are never overwritten:
 * issued documents are immutable.
 *
 * @example
 * ```ts
 * EInvoicePlugin.init({
 *   secret: process.env.E_INVOICE_SECRET!,
 *   storage: new LocalFileInvoiceStorageStrategy({ dir: path.join(__dirname, '../invoices') }),
 * });
 * ```
 *
 * @category Strategies
 */
export class LocalFileInvoiceStorageStrategy implements InvoiceStorageStrategy {
  private readonly dir: string;

  constructor(options: LocalFileInvoiceStorageOptions) {
    if (!options?.dir) throw new Error('LocalFileInvoiceStorageStrategy: `dir` is required');
    this.dir = path.resolve(options.dir);
  }

  /** @internal */
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async save(_ctx: RequestContext, file: StoredFileInput): Promise<string> {
    const key = safeKey(file.key);
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(target, file.data, { flag: 'wx' });
      return key;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // Left over from an attempt whose transaction was rolled back: reuse it if identical, else store beside it
    const existing = await fs.readFile(target);
    if (existing.equals(file.data)) return key;
    const ext = path.extname(key);
    const variant = `${key.slice(0, key.length - ext.length)}.${sha256(file.data).slice(0, 12)}${ext}`;
    try {
      await fs.writeFile(this.resolve(variant), file.data, { flag: 'wx' });
    } catch (e) {
      // Same content written by an earlier attempt
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    return variant;
  }

  async read(_ctx: RequestContext, storageId: string): Promise<Buffer> {
    return fs.readFile(this.resolve(safeKey(storageId)));
  }

  private resolve(key: string): string {
    const target = path.resolve(this.dir, key);
    if (!target.startsWith(this.dir + path.sep)) throw new Error(`Invalid storage key ${key}`);
    return target;
  }
}

/**
 * Keys are relative paths with safe segments only.
 *
 * @internal
 */
export function safeKey(key: string): string {
  const segments = key.split('/').map((s) => s.replace(/[^A-Za-z0-9._-]+/g, '_'));
  if (!segments.length || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Invalid storage key ${key}`);
  }
  return segments.join('/');
}

function sha256(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}
