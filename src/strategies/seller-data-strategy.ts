import { Injector, Order, RequestContext, TransactionalConnection } from '@vendure/core';

import { Seller } from '../core';
import { EInvoiceChannelSettings, SellerSettings } from '../entities/e-invoice-channel-settings.entity';

import { SellerData, SellerDataStrategy } from './types';

/**
 * Default: seller data from the e-invoice settings of the order's channel ({@link EInvoiceChannelSettings}).
 *
 * @category Strategies
 */
export class ChannelSettingsSellerStrategy implements SellerDataStrategy {
  private connection: TransactionalConnection;

  /** @internal */
  init(injector: Injector) {
    this.connection = injector.get(TransactionalConnection);
  }

  async getSeller(ctx: RequestContext, _order: Order): Promise<SellerData | undefined> {
    const settings = await this.connection.getRepository(ctx, EInvoiceChannelSettings).findOne({ where: { channelId: ctx.channelId } });
    if (!settings) return undefined;
    return {
      seller: sellerFromSettings(settings.seller),
      bank: settings.seller.bank?.iban ? settings.seller.bank : undefined,
      paymentTerms: settings.payment.termsText,
      paymentTermDays: settings.payment.termDays,
    };
  }
}

/**
 * Missing fields become empty strings; the checks report them as `SELLER_INCOMPLETE`.
 *
 * @internal
 */
export function sellerFromSettings(s: SellerSettings): Seller {
  return {
    name: s.name ?? '',
    tradingName: s.tradingName || undefined,
    address: {
      line1: s.address?.line1 ?? '',
      line2: s.address?.line2 || undefined,
      line3: s.address?.line3 || undefined,
      postalCode: s.address?.postalCode ?? '',
      city: s.address?.city ?? '',
      countryCode: s.address?.countryCode ?? '',
      subdivision: s.address?.subdivision || undefined,
    },
    vatId: s.vatId || undefined,
    taxNumber: s.taxNumber || undefined,
    legalRegistration: s.legalRegistration?.id ? s.legalRegistration : undefined,
    legalInfo: s.legalInfo || undefined,
    contact: { name: s.contact?.name ?? '', phone: s.contact?.phone ?? '', email: s.contact?.email ?? '' },
    electronicAddress: s.electronicAddress?.value ? s.electronicAddress : undefined,
  };
}
