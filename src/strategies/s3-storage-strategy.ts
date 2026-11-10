import { RequestContext } from '@vendure/core';
import { createHash } from 'crypto';

import { safeKey } from './local-file-storage-strategy';
import { InvoiceStorageStrategy, StoredFileInput } from './types';

/** The part of `S3Client` from `@aws-sdk/client-s3` this strategy uses. */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface S3InvoiceStorageOptions {
  bucket: string;
  /** Key prefix, e.g. `invoices/`. Default: none */
  prefix?: string;
  /** An `S3Client` instance. Default: `new S3Client(clientConfig)` */
  client?: S3ClientLike;
  /** Config for the default client, e.g. `{ region: 'eu-central-1' }` or an endpoint for S3-compatible storage */
  clientConfig?: Record<string, unknown>;
  serverSideEncryption?: 'AES256' | 'aws:kms';
  /**
   * Refuse to overwrite existing objects (`If-None-Match: *`). Default: `true`. Disable for S3-compatible
   * services that do not support conditional writes.
   */
  conditionalWrites?: boolean;
}

type S3Module = {
  S3Client: new (config: Record<string, unknown>) => S3ClientLike;
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
};

/**
 * Stores the files in an S3 bucket (or S3-compatible storage). Requires the optional peer dependency
 * `@aws-sdk/client-s3`. Keep the bucket private; downloads go through the plugin's signed links.
 * For retention requirements (§147 AO) consider S3 Object Lock on the bucket.
 */
export class S3InvoiceStorageStrategy implements InvoiceStorageStrategy {
  private s3: S3Module;
  private client: S3ClientLike;

  constructor(private options: S3InvoiceStorageOptions) {
    if (!options?.bucket) throw new Error('S3InvoiceStorageStrategy: `bucket` is required');
  }

  init() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.s3 = require('@aws-sdk/client-s3') as S3Module;
    } catch {
      throw new Error('S3InvoiceStorageStrategy needs the package @aws-sdk/client-s3 (pnpm add @aws-sdk/client-s3)');
    }
    this.client = this.options.client ?? new this.s3.S3Client(this.options.clientConfig ?? {});
  }

  async save(_ctx: RequestContext, file: StoredFileInput): Promise<string> {
    const key = `${this.options.prefix ?? ''}${safeKey(file.key)}`;
    if (await this.put(key, file)) return key;
    // Left over from an attempt whose transaction was rolled back: reuse it if identical, else store beside it
    if ((await this.get(key)).equals(file.data)) return key;
    const dot = key.lastIndexOf('.');
    const hash = createHash('sha256').update(file.data).digest('hex').slice(0, 12);
    const variant = dot > key.lastIndexOf('/') ? `${key.slice(0, dot)}.${hash}${key.slice(dot)}` : `${key}.${hash}`;
    await this.put(variant, file);
    return variant;
  }

  async read(_ctx: RequestContext, storageId: string): Promise<Buffer> {
    return this.get(storageId);
  }

  /** `false` if the object already exists. */
  private async put(key: string, file: StoredFileInput): Promise<boolean> {
    const conditional = this.options.conditionalWrites ?? true;
    try {
      await this.client.send(
        new this.s3.PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: file.data,
          ContentType: file.mimeType,
          ChecksumSHA256: createHash('sha256').update(file.data).digest('base64'),
          ...(conditional ? { IfNoneMatch: '*' } : {}),
          ...(this.options.serverSideEncryption ? { ServerSideEncryption: this.options.serverSideEncryption } : {}),
        }),
      );
      return true;
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (conditional && (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412)) return false;
      throw e;
    }
  }

  private async get(key: string): Promise<Buffer> {
    const res = (await this.client.send(new this.s3.GetObjectCommand({ Bucket: this.options.bucket, Key: key }))) as {
      Body?: { transformToByteArray(): Promise<Uint8Array> };
    };
    if (!res.Body) throw new Error(`S3 object ${key} has no body`);
    return Buffer.from(await res.Body.transformToByteArray());
  }
}
