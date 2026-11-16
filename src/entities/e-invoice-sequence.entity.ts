import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity } from 'typeorm';

/**
 * A gap-free counter, e.g. key `default|invoice|2026`. Incremented row-locked inside the issuing transaction;
 * the key comes from the {@link InvoiceNumberStrategy}.
 *
 * @category Entities
 */
@Entity('e_invoice_sequence')
export class EInvoiceSequence extends VendureEntity {
  /** @internal */
  constructor(input?: DeepPartial<EInvoiceSequence>) {
    super(input);
  }

  @Column('varchar', { unique: true })
  key: string;

  @Column('int')
  lastValue: number;
}
