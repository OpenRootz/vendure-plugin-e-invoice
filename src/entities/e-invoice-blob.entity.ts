import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, getMetadataArgsStorage } from 'typeorm';

/**
 * File content for the {@link DatabaseInvoiceStorageStrategy}.
 *
 * The binary column type differs per database, so the `data` column is defined at bootstrap
 * by {@link defineBlobColumn} once the database type is known.
 */
@Entity('e_invoice_blob')
export class EInvoiceBlob extends VendureEntity {
  constructor(input?: DeepPartial<EInvoiceBlob>) {
    super(input);
  }

  @Column('varchar')
  mimeType: string;

  data: Buffer;
}

const BLOB_TYPES: Record<string, 'bytea' | 'longblob' | 'blob'> = {
  postgres: 'bytea',
  cockroachdb: 'bytea',
  mysql: 'longblob',
  mariadb: 'longblob',
};

export function defineBlobColumn(dbType: string): void {
  const defined = getMetadataArgsStorage().columns.some((c) => c.target === EInvoiceBlob && c.propertyName === 'data');
  if (defined) return;
  Column({ type: BLOB_TYPES[dbType] ?? 'blob' })(EInvoiceBlob.prototype, 'data');
}
