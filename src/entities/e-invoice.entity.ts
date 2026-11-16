import { DeepPartial, EntityId, ID, Money, Order, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';

import { EInvoiceFormat, EInvoiceModel, EInvoiceType, InvoiceIssue } from '../core';

import { ValidationMessage } from '../strategies/types';

import { EInvoiceFile } from './e-invoice-file.entity';

/**
 * Status of an {@link EInvoice}:
 * - `BLOCKED`: the checks failed; no number has been reserved. Fix the cause and retry.
 * - `PENDING`: number reserved, snapshot stored, files are being rendered.
 * - `ISSUED`: files rendered and stored. Final; corrections only through credit notes.
 * - `FAILED`: rendering failed. Retry renders again from the snapshot.
 * - `VOID`: a failed invoice that can never be rendered. The number stays consumed and the reason is documented.
 *
 * @category Entities
 */
export type EInvoiceStatus = 'BLOCKED' | 'PENDING' | 'ISSUED' | 'FAILED' | 'VOID';
/**
 * Result of the runtime validation (option `validation`) stored on an {@link EInvoice}.
 *
 * @category Entities
 */
export interface ValidationSummary {
  mode: 'report' | 'enforce';
  validatedAt: string;
  valid: boolean;
  results: { format: EInvoiceFormat; valid: boolean; validator: string; messages: ValidationMessage[] }[];
  /** The validator could not be reached or failed */
  error?: string;
}

/**
 * Why a document was created: `auto` (trigger), `manual` (issued or credited by an admin), `refund`,
 * `cancellation` (order cancelled), `modification` (order modified: credit note + new invoice),
 * `reissue` (cancel and reissue by an admin: credit note + new invoice).
 *
 * @category Entities
 */
export type EInvoiceReason = 'auto' | 'manual' | 'refund' | 'cancellation' | 'modification' | 'reissue';

/**
 * An invoice or credit note of an order. Once a number has been reserved, the document data (`model`) is an
 * immutable snapshot; the files are rendered only from it, and corrections are made through credit notes.
 *
 * @category Entities
 */
@Entity('e_invoice')
@Index(['channelId', 'number'], { unique: true })
@Index(['orderId', 'position'], { unique: true })
export class EInvoice extends VendureEntity {
  /** @internal */
  constructor(input?: DeepPartial<EInvoice>) {
    super(input);
  }

  /** Channel the document belongs to; numbers are unique per channel. */
  @EntityId()
  channelId: ID;

  @Index()
  @ManyToOne(() => Order, { onDelete: 'RESTRICT' })
  order: Order;

  @EntityId()
  orderId: ID;

  /**
   * Creation order within the order (1, 2, …; gaps where a BLOCKED document was removed). The documents of an order
   * are sorted by this, not by `createdAt`, which can go backwards (clock steps, transaction start in Postgres).
   */
  @Column('int')
  position: number;

  /** Invoice or credit note. */
  @Column('varchar')
  type: EInvoiceType;

  @Column('varchar')
  status: EInvoiceStatus;

  @Column('varchar')
  reason: EInvoiceReason;

  /** BT-1, null until a number has been reserved */
  @Column('varchar', { nullable: true })
  number: string | null;

  /** Key of the counter the number was drawn from, e.g. `default|invoice|2026` */
  @Column('varchar', { nullable: true })
  sequenceKey: string | null;

  /** Counter value of the number */
  @Column('int', { nullable: true })
  sequenceValue: number | null;

  /** BT-2 issue date (`YYYY-MM-DD`), set when the number is reserved */
  @Column('varchar', { nullable: true, length: 10 })
  issueDate: string | null;

  /** BT-5 */
  @Column('varchar')
  currencyCode: string;

  /** BT-109 total without VAT, in minor units */
  @Money()
  totalNet: number;

  /** BT-110 total VAT, in minor units */
  @Money()
  totalTax: number;

  /** BT-112 total with VAT, in minor units */
  @Money()
  totalWithTax: number;

  /** The invoice data. Immutable once a number has been reserved; files are only rendered from this snapshot. */
  @Column('simple-json', { nullable: true })
  model: EInvoiceModel | null;

  /** Formats to render, decided by the {@link InvoiceFormatStrategy} */
  @Column('simple-json')
  formats: EInvoiceFormat[];

  /** The rendered files, once ISSUED */
  @OneToMany(() => EInvoiceFile, (f) => f.invoice)
  files: EInvoiceFile[];

  /** Credit notes: the invoice they correct (BT-25) */
  @ManyToOne(() => EInvoice, { nullable: true })
  correctedInvoice: EInvoice | null;

  @EntityId({ nullable: true })
  correctedInvoiceId: ID | null;

  /** The Vendure refund a credit note was created for (one credit note per refund) */
  @Index({ unique: true })
  @Column('varchar', { nullable: true })
  refundId: string | null;

  /** Invoices: hash of the invoiced order amounts, to detect a later order modification */
  @Column('varchar', { nullable: true, length: 64 })
  orderFingerprint: string | null;

  /** Why the invoice is BLOCKED */
  @Column('simple-json', { nullable: true })
  issues: InvoiceIssue[] | null;

  /** Why the invoice is FAILED */
  @Column('text', { nullable: true })
  errorMessage: string | null;

  /** Why the document is VOID; documents the gap in the number sequence */
  @Column('varchar', { nullable: true })
  voidReason: string | null;

  /** Result of the runtime validation (option `validation`), if it ran */
  @Column('simple-json', { nullable: true })
  validation: ValidationSummary | null;
}
