import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

import { Address, Contact, ElectronicAddress, PdfLayout, PdfLayoutV2 } from '../core';
import { BankAccount } from '../strategies/types';

/**
 * Seller data stored in the e-invoice settings of a channel; read by the {@link ChannelSettingsSellerStrategy}.
 *
 * @category Entities
 */
export interface SellerSettings {
  name?: string;
  tradingName?: string;
  address?: Partial<Address>;
  vatId?: string;
  taxNumber?: string;
  legalRegistration?: { id: string; scheme?: string };
  legalInfo?: string;
  contact?: Contact;
  electronicAddress?: ElectronicAddress;
  bank?: BankAccount;
}

/**
 * Payment terms stored in the e-invoice settings of a channel.
 *
 * @category Entities
 */
export interface PaymentSettings {
  /** BT-20 payment terms for amounts that are still due, e.g. "Zahlbar innerhalb von 14 Tagen ohne Abzug." */
  termsText?: string;
  /** Days from the issue date to the due date (BT-9) */
  termDays?: number;
}

/**
 * The stored layout: the layout document (v2) with the logo asset.
 *
 * @category Entities
 */
export type LayoutSettings = PdfLayoutV2 & { logoAssetId?: ID };

/**
 * Layouts stored before the layout editor (v1): accent color and texts; converted when read.
 *
 * @category Entities
 */
export type LegacyLayoutSettings = PdfLayout & { logoAssetId?: ID };

/**
 * E-invoicing settings of a channel: seller data, payment terms and PDF layout. Edited in the dashboard
 * (Settings → E-Invoices) or through {@link ChannelSettingsService}.
 *
 * @category Entities
 */
@Entity('e_invoice_channel_settings')
@Index(['channelId'], { unique: true })
export class EInvoiceChannelSettings extends VendureEntity {
  /** @internal */
  constructor(input?: DeepPartial<EInvoiceChannelSettings>) {
    super(input);
  }

  @EntityId()
  channelId: ID;

  /** E-invoicing is off for a channel until it is enabled */
  @Column({ default: false })
  enabled: boolean;

  /** Issue invoices automatically when an order reaches one of the `issueOnStates` */
  @Column({ default: true })
  autoIssue: boolean;

  /** Send issued documents to the buyer automatically (option `delivery`); off until enabled */
  @Column({ default: false })
  deliveryEnabled: boolean;

  /** Blind copy of every automatic sending, e.g. for the accountant or an archive address */
  @Column('varchar', { nullable: true })
  deliveryBcc: string | null;

  @Column('simple-json')
  seller: SellerSettings;

  @Column('simple-json')
  payment: PaymentSettings;

  /** v1 layouts are converted to v2 by `ChannelSettingsService.get` and written back on the next save */
  @Column('simple-json')
  layout: LayoutSettings;
}
