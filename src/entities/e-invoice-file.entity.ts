import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, ManyToOne } from 'typeorm';

import { EInvoiceFormat } from '../core';

import { EInvoice } from './e-invoice.entity';

/** A rendered file of an invoice (ZUGFeRD PDF, XRechnung XML). */
@Entity('e_invoice_file')
export class EInvoiceFile extends VendureEntity {
  constructor(input?: DeepPartial<EInvoiceFile>) {
    super(input);
  }

  @ManyToOne(() => EInvoice, (i) => i.files, { onDelete: 'RESTRICT' })
  invoice: EInvoice;

  @EntityId()
  invoiceId: ID;

  @Column('varchar')
  format: EInvoiceFormat;

  @Column('varchar')
  fileName: string;

  @Column('varchar')
  mimeType: string;

  @Column('int')
  size: number;

  /** Hex SHA-256 of the content, for tamper evidence */
  @Column('varchar', { length: 64 })
  sha256: string;

  /** Opaque ID returned by the InvoiceStorageStrategy */
  @Column('varchar')
  storageId: string;
}
