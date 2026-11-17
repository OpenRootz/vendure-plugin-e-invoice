import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { EInvoice } from './e-invoice.entity';

/**
 * Status of an {@link EInvoiceDelivery}:
 * - `queued`: handed to the {@link InvoiceDeliveryStrategy}, no attempt reported yet.
 * - `retrying`: an attempt failed; the transport tries again.
 * - `sent`: the transport accepted the email.
 * - `failed`: the last attempt failed, or the delivery could not be prepared. Send it again manually.
 *
 * @category Entities
 */
export type EInvoiceDeliveryStatus = 'queued' | 'retrying' | 'sent' | 'failed';

/**
 * Why a document was sent: `auto` (when it was issued), `manual` (by an admin), `request` (the buyer asked for it
 * with `requestInvoiceDownloadLink`).
 *
 * @category Entities
 */
export type EInvoiceDeliveryTrigger = 'auto' | 'manual' | 'request';

/**
 * One sending of an issued invoice or credit note, e.g. by email. Every repeat is a new row; the document itself
 * stays unchanged.
 *
 * @category Entities
 */
@Entity('e_invoice_delivery')
@Index(['orderId', 'trigger', 'queuedAt'])
export class EInvoiceDelivery extends VendureEntity {
  /** @internal */
  constructor(input?: DeepPartial<EInvoiceDelivery>) {
    super(input);
  }

  @EntityId()
  channelId: ID;

  @Index()
  @ManyToOne(() => EInvoice, { onDelete: 'RESTRICT' })
  invoice: EInvoice;

  @EntityId()
  invoiceId: ID;

  /** The order of the document; used for the rate limit of `requestInvoiceDownloadLink` */
  @EntityId()
  orderId: ID;

  @Column('varchar')
  trigger: EInvoiceDeliveryTrigger;

  @Column('varchar')
  status: EInvoiceDeliveryStatus;

  /** Email address (or another address the delivery strategy understands); empty if none was found */
  @Column('varchar')
  recipient: string;

  /** Blind copy, from the channel settings (automatic sending only) */
  @Column('varchar', { nullable: true })
  bcc: string | null;

  /** Number of attempts the transport reported */
  @Column('int', { default: 0 })
  attempts: number;

  /** The files were too large to attach (option `delivery.maxAttachmentBytes`); the email contains download links */
  @Column({ default: false })
  linkOnly: boolean;

  /**
   * When the delivery was created, set by the plugin. The rate limit compares this column and not `createdAt`, which
   * the database sets with its own clock and time zone.
   */
  @Column({ type: Date })
  queuedAt: Date;

  /** The error of the last failed attempt */
  @Column('text', { nullable: true })
  errorMessage: string | null;

  @Column({ type: Date, nullable: true })
  sentAt: Date | null;
}
