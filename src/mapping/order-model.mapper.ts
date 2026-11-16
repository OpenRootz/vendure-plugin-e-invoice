import { Inject, Injectable } from '@nestjs/common';
import {
  ConfigService,
  ID,
  idsAreEqual,
  Order,
  OrderLine,
  PaymentMethod,
  RequestContext,
  TaxRate,
  TaxRateService,
  TransactionalConnection,
} from '@vendure/core';

import { createHash } from 'crypto';

import { PLUGIN_INIT_OPTIONS } from '../constants';
import { Buyer, EInvoiceFormat, EInvoiceModel, IsoDate, PaymentMeans, VatCategory, VatCategoryCode } from '../core';
import { ResolvedEInvoicePluginOptions } from '../options';
import { SellerData } from '../strategies/types';

import { buildModel, isoDateInZone, rateToDecimal } from './build-model';

const compareIds = (a: ID, b: ID) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
const compareCreated = (a: { createdAt: Date; id: ID }, b: { createdAt: Date; id: ID }) =>
  a.createdAt.getTime() - b.createdAt.getTime() || compareIds(a.id, b.id);

/**
 * Loaded relations come back in no particular order, which would make line numbers and line IDs of new
 * documents arbitrary. Lines follow Vendure's own order (`OrderService.findOne`: creation time, then
 * variant); the ID makes every order total.
 */
export function sortOrderRelations(order: Order): Order {
  order.lines?.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareIds(a.productVariantId, b.productVariantId) || compareIds(a.id, b.id),
  );
  order.shippingLines?.sort(compareCreated);
  order.surcharges?.sort(compareCreated);
  order.payments?.sort(compareCreated);
  return order;
}

/** Relations the mapper needs on the order. */
export const ORDER_RELATIONS = [
  'customer',
  'lines',
  'lines.productVariant',
  'lines.productVariant.translations',
  'shippingLines',
  'shippingLines.shippingMethod',
  'shippingLines.shippingMethod.translations',
  'surcharges',
  'payments',
] as const;

/**
 * Hash of everything an invoice amount depends on: line quantities and amounts, shipping, surcharges and the total.
 * A different fingerprint after an order modification means the invoice no longer matches the order.
 */
export function orderFingerprint(order: Order): string {
  const data = {
    lines: order.lines
      .filter((l) => l.quantity > 0)
      .map((l) => [String(l.id), l.quantity, l.proratedLinePrice, l.proratedLinePriceWithTax])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    shipping: (order.shippingLines ?? []).map((s) => [String(s.shippingMethodId), s.discountedPrice, s.discountedPriceWithTax]),
    surcharges: (order.surcharges ?? []).map((s) => [s.sku ?? s.description, s.price, s.priceWithTax]),
    total: order.totalWithTax,
  };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/**
 * Result of {@link OrderModelMapper.toModel}.
 *
 * @category Mapping
 */
export interface MappedOrder {
  /** Model without number; totals not yet calculated */
  model: EInvoiceModel;
  /** Formats decided by the {@link InvoiceFormatStrategy} */
  formats: EInvoiceFormat[];
}

/**
 * Turns a Vendure order into the neutral invoice model, using the configured strategies and mapping hooks.
 * Returns `undefined` when the order's channel has no seller data (e-invoicing not set up).
 *
 * @category Services
 */
@Injectable()
export class OrderModelMapper {
  /** @internal */
  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions,
    private connection: TransactionalConnection,
    private configService: ConfigService,
    private taxRateService: TaxRateService,
  ) {}

  /** Loads an order of the current channel; orders of other channels are `undefined`. */
  async loadOrder(ctx: RequestContext, orderId: ID): Promise<Order | undefined> {
    const order = await this.connection.getRepository(ctx, Order).findOne({
      where: { id: orderId, channels: { id: ctx.channelId } },
      relations: [...ORDER_RELATIONS],
    });
    return order ? sortOrderRelations(order) : undefined;
  }

  /**
   * Maps an order loaded with {@link OrderModelMapper.loadOrder} to the invoice model (without number and totals)
   * and the formats to render. `undefined` when the channel has no seller data.
   */
  async toModel(ctx: RequestContext, order: Order, issueDate: IsoDate = this.today()): Promise<MappedOrder | undefined> {
    const { mapping } = this.options;
    const seller = await this.options.sellerStrategy.getSeller(ctx, order);
    if (!seller) return undefined;
    const buyer = await this.options.buyerStrategy.getBuyer(ctx, order);
    const formats = await this.options.formatStrategy.formats(ctx, order, buyer);
    const language = mapping.language?.(ctx, order) ?? ctx.channel.defaultLanguageCode;

    const lineCategories = new Map<ID, VatCategory>();
    for (const line of order.lines) {
      lineCategories.set(line.id, await this.lineCategory(ctx, order, line, buyer.buyer));
    }
    const paymentMethods = await this.paymentMethods(ctx);

    let model = buildModel({
      order,
      seller,
      buyer,
      channelCode: ctx.channel.code,
      pricesIncludeTax: ctx.channel.pricesIncludeTax,
      issueDate,
      deliveryDate: (await mapping.deliveryDate?.(ctx, order)) ?? issueDate,
      language,
      amountDecimals: this.configService.entityOptions.moneyStrategy?.precision ?? 2,
      taxCalculation: this.options.taxCalculation,
      priceDisplay: mapping.priceDisplay?.(ctx, order, buyer.buyer) ?? (buyer.buyer.isBusiness ? 'net' : 'gross'),
      lineCategory: (line) => lineCategories.get(line.id) as VatCategory,
      otherCategory: (rate) => this.otherCategory(ctx, order, rate, lineCategories, buyer.buyer),
      paymentMeans: (payment) => {
        const custom = mapping.paymentMeans?.(ctx, { order, payment, seller: seller.seller });
        return custom ?? defaultPaymentMeans(paymentMethods.get(payment.method), payment.method, seller);
      },
      unitCode: (line) => mapping.unitCode?.(ctx, line) ?? 'H87',
      lineName: (line) => translated(line.productVariant, language) ?? `#${line.productVariantId}`,
      shippingName: (sl) => (sl.shippingMethod ? translated(sl.shippingMethod, language) : undefined),
    });
    if (mapping.transformModel) model = await mapping.transformModel(ctx, model, order);
    return { model, formats };
  }

  /** Today's date in the configured `timeZone`. */
  today(): IsoDate {
    return isoDateInZone(new Date(), this.options.timeZone);
  }

  private async lineCategory(ctx: RequestContext, order: Order, line: OrderLine, buyer: Buyer): Promise<VatCategory> {
    const rate = line.taxRate;
    let taxRate: TaxRate | undefined;
    if (order.taxZoneId && line.taxCategoryId) {
      const applicable = await this.taxRateService.getApplicableTaxRate(ctx, order.taxZoneId, line.taxCategoryId);
      // a custom TaxLineCalculationStrategy may have applied a different rate; then the custom fields do not apply
      if (applicable?.id && applicable.value === rate) taxRate = applicable;
    }
    const defaultCategory = categoryFromTaxRate(rate, taxRate);
    return this.options.mapping.taxCategory?.(ctx, { order, line, rate, defaultCategory, buyer }) ?? defaultCategory;
  }

  /** Shipping and surcharges follow the category of the goods with the same rate (accessory supply). */
  private otherCategory(ctx: RequestContext, order: Order, rate: number, lines: Map<ID, VatCategory>, buyer: Buyer): VatCategory {
    const decimal = rateToDecimal(rate);
    const fromLine = [...lines.values()].find((c) => c.rate === decimal);
    const defaultCategory = fromLine ?? categoryFromTaxRate(rate, undefined);
    return this.options.mapping.taxCategory?.(ctx, { order, rate, defaultCategory, buyer }) ?? defaultCategory;
  }

  private async paymentMethods(ctx: RequestContext): Promise<Map<string, PaymentMethod>> {
    const methods = await this.connection.getRepository(ctx, PaymentMethod).find({ relations: ['channels', 'translations'] });
    return new Map(methods.filter((m) => m.channels.some((c) => idsAreEqual(c.id, ctx.channelId))).map((m) => [m.code, m]));
  }
}

/** Without a category on the tax rate: rate > 0 → S. A 0 % rate stays `S`/0, which the checks report as missing category. */
export function categoryFromTaxRate(rate: number, taxRate: TaxRate | undefined): VatCategory {
  const cf = taxRate?.customFields;
  const code = (cf?.eInvoiceCategoryCode || 'S') as VatCategoryCode;
  return {
    code,
    rate: rateToDecimal(rate),
    exemptionReason: cf?.eInvoiceExemptionReason || undefined,
    exemptionReasonCode: cf?.eInvoiceExemptionReasonCode || undefined,
  };
}

function defaultPaymentMeans(method: PaymentMethod | undefined, methodCode: string, seller: SellerData): PaymentMeans {
  const code = method?.customFields?.eInvoicePaymentMeansCode || 'ZZZ';
  const text = (method && translated(method, undefined)) || methodCode;
  if (code === '58')
    return { code: '58', iban: seller.bank?.iban ?? '', bic: seller.bank?.bic, accountName: seller.bank?.accountName, text };
  return { code, text };
}

function translated(
  entity: { name?: string; translations?: { languageCode: string; name: string }[] },
  language: string | undefined,
): string | undefined {
  const t = entity.translations?.find((x) => x.languageCode === language) ?? entity.translations?.[0];
  return t?.name || entity.name || undefined;
}
