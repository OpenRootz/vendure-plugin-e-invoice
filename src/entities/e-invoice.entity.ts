import { DeepPartial, EntityId, ID, Money, Order, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';

import { EInvoiceFormat, EInvoiceModel, EInvoiceType, InvoiceIssue } from '../core';

import { EInvoiceFile } from './e-invoice-file.entity';

/**
 * - `BLOCKED`: the checks failed; no number has been reserved. Fix the cause and retry.
 * - `PENDING`: number reserved, snapshot stored, files are being rendered.
 * - `ISSUED`: files rendered and stored. Final; corrections only through credit notes.
 * - `FAILED`: rendering failed. Retry renders again from the snapshot.
 * - `VOID`: a failed invoice that can never be rendered. The number stays consumed and the reason is documented.
 */
export type EInvoiceStatus = 'BLOCKED' | 'PENDING' | 'ISSUED' | 'FAILED' | 'VOID';
export type EInvoiceReason = 'auto' | 'manual' | 'refund' | 'cancellation' | 'modification';

@Entity('e_invoice')
@Index(['channelId', 'number'], { unique: true })
export class EInvoice extends VendureEntity {
  constructor(input?: DeepPartial<EInvoice>) {
    super(input);
  }

  @EntityId()
  channelId: ID;

  @Index()
  @ManyToOne(() => Order, { onDelete: 'RESTRICT' })
  order: Order;

  @EntityId()
  orderId: ID;

  @Column('varchar')
  type: EInvoiceType;

  @Column('varchar')
  status: EInvoiceStatus;

  @Column('varchar')
  reason: EInvoiceReason;

  /** BT-1, null until a number has been reserved */
  @Column('varchar', { nullable: true })
  number: string | null;

  @Column('varchar', { nullable: true })
  sequenceKey: string | null;

  @Column('int', { nullable: true })
  sequenceValue: number | null;

  @Column('varchar', { nullable: true, length: 10 })
  issueDate: string | null;

  @Column('varchar')
  currencyCode: string;

  @Money()
  totalNet: number;

  @Money()
  totalTax: number;

  @Money()
  totalWithTax: number;

  /** The invoice data. Immutable once a number has been reserved; files are only rendered from this snapshot. */
  @Column('simple-json', { nullable: true })
  model: EInvoiceModel | null;

  @Column('simple-json')
  formats: EInvoiceFormat[];

  @OneToMany(() => EInvoiceFile, (f) => f.invoice)
  files: EInvoiceFile[];

  @ManyToOne(() => EInvoice, { nullable: true })
  correctedInvoice: EInvoice | null;

  @EntityId({ nullable: true })
  correctedInvoiceId: ID | null;

  @Index({ unique: true })
  @Column('varchar', { nullable: true })
  refundId: string | null;

  /** Why the invoice is BLOCKED */
  @Column('simple-json', { nullable: true })
  issues: InvoiceIssue[] | null;

  /** Why the invoice is FAILED */
  @Column('text', { nullable: true })
  errorMessage: string | null;

  @Column('varchar', { nullable: true })
  voidReason: string | null;
}
