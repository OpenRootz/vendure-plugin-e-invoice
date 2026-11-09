import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

import { Address, Contact, ElectronicAddress } from '../core';
import { BankAccount } from '../strategies/types';

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

export interface PaymentSettings {
  /** BT-20 payment terms for amounts that are still due, e.g. "Zahlbar innerhalb von 14 Tagen ohne Abzug." */
  termsText?: string;
  /** Days from the issue date to the due date (BT-9) */
  termDays?: number;
}

export interface LayoutSettings {
  logoAssetId?: ID;
  accentColor?: string;
  introText?: string;
  closingText?: string;
  footerText?: string;
}

/** E-invoicing settings of a channel: seller data, payment terms and PDF layout. */
@Entity('e_invoice_channel_settings')
@Index(['channelId'], { unique: true })
export class EInvoiceChannelSettings extends VendureEntity {
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

  @Column('simple-json')
  seller: SellerSettings;

  @Column('simple-json')
  payment: PaymentSettings;

  @Column('simple-json')
  layout: LayoutSettings;
}
