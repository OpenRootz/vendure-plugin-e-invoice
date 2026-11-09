import { Injector, RequestContext, TransactionalConnection } from '@vendure/core';

import { EInvoiceBlob } from '../entities/e-invoice-blob.entity';

import { InvoiceStorageStrategy, StoredFileInput } from './types';

/**
 * Default storage: file contents in the `e_invoice_blob` table.
 * Works in every setup without configuration (server and worker share the database), is covered by
 * the regular database backup and is written in the same transaction as the invoice.
 */
export class DatabaseInvoiceStorageStrategy implements InvoiceStorageStrategy {
  private connection: TransactionalConnection;

  init(injector: Injector) {
    this.connection = injector.get(TransactionalConnection);
  }

  async save(ctx: RequestContext, file: StoredFileInput): Promise<string> {
    const blob = await this.connection
      .getRepository(ctx, EInvoiceBlob)
      .save(new EInvoiceBlob({ mimeType: file.mimeType, data: file.data }));
    return String(blob.id);
  }

  async read(ctx: RequestContext, storageId: string): Promise<Buffer> {
    const blob = await this.connection.getRepository(ctx, EInvoiceBlob).findOneOrFail({ where: { id: storageId } });
    return Buffer.from(blob.data);
  }
}
