import { Order, OrderLine, Payment, ShippingLine, Surcharge } from '@vendure/core';

import { AllowanceCharge, EInvoiceModel, InvoiceLine, IsoDate, normalizeDecimal, PaymentMeans, TaxCalculation, VatCategory } from '../core';
import { BuyerData, SellerData } from '../strategies/types';

import { mappingLabels } from './labels';

/**
 * Everything the model builder needs besides the order; resolved by {@link OrderModelMapper}.
 *
 * @category Mapping
 */
export interface BuildModelInput {
  /** Order with `lines.productVariant`, `shippingLines.shippingMethod`, `surcharges` and `payments` loaded */
  order: Order;
  seller: SellerData;
  buyer: BuyerData;
  channelCode: string;
  pricesIncludeTax: boolean;
  issueDate: IsoDate;
  deliveryDate?: IsoDate;
  language: string;
  amountDecimals: number;
  taxCalculation: TaxCalculation;
  priceDisplay: 'gross' | 'net';
  /** VAT category of an order line */
  lineCategory: (line: OrderLine) => VatCategory;
  /** VAT category of a shipping line or surcharge with the given rate */
  otherCategory: (rate: number) => VatCategory;
  /** Payment means for a settled or authorized payment, `undefined` to skip it */
  paymentMeans: (payment: Payment) => PaymentMeans | undefined;
  unitCode: (line: OrderLine) => string;
  /** Translated product / shipping method names */
  lineName: (line: OrderLine) => string;
  shippingName: (shippingLine: ShippingLine) => string | undefined;
}

/**
 * Builds the invoice model (without number and totals) from an order.
 *
 * Amounts are taken from Vendure as they are, so the invoice matches what the customer was charged:
 * - BT-146 net unit price = `unitPrice`, BT-131 line net amount = `proratedLinePrice` (item and order promotions).
 * - The difference `quantity × unitPrice − proratedLinePrice` becomes line allowances (promotions) and,
 *   in gross-price channels, a rounding allowance or charge, so BT-131 = qty × price − allowances + charges holds exactly.
 * - Shipping lines become document-level charges (`FC`); surcharges become charges, negative ones allowances.
 * - Settled payments are the prepaid amount (BT-113), at most the order total.
 *
 * @category Mapping
 */
export function buildModel(input: BuildModelInput): EInvoiceModel {
  const { order } = input;
  const labels = mappingLabels(input.language);

  const lines: InvoiceLine[] = order.lines.filter((l) => l.quantity > 0).map((line, index) => mapLine(input, line, index, labels));

  const charges: AllowanceCharge[] = [];
  const allowances: AllowanceCharge[] = [];
  for (const shippingLine of order.shippingLines ?? []) {
    const amount = shippingLine.discountedPrice;
    if (amount === 0) continue;
    charges.push({
      amount,
      reason: input.shippingName(shippingLine) || labels.shipping,
      reasonCode: 'FC',
      vat: input.otherCategory(shippingLine.taxRate),
      vendureTaxAmount: shippingLine.discountedPriceWithTax - amount,
    });
  }
  for (const surcharge of order.surcharges ?? []) {
    const item = (amount: number, tax: number): AllowanceCharge => ({
      amount,
      reason: surcharge.description || labels.surcharge,
      vat: input.otherCategory(surcharge.taxRate),
      vendureTaxAmount: tax,
    });
    const tax = surchargeTax(surcharge);
    if (surcharge.price > 0) charges.push(item(surcharge.price, tax));
    else if (surcharge.price < 0) allowances.push(item(-surcharge.price, -tax));
  }

  const payments = order.payments ?? [];
  // Capped at the total: after a modification or partial cancellation the payment can exceed the new total (the
  // difference is refunded), and an amount-only refund (e.g. goodwill) does not change the order total
  const settled = payments.filter((p) => p.state === 'Settled').reduce((s, p) => s + p.amount, 0);
  const prepaidAmount = Math.min(settled, order.totalWithTax);
  const means: PaymentMeans[] = [];
  for (const payment of payments.filter((p) => p.state === 'Settled' || p.state === 'Authorized')) {
    const m = input.paymentMeans(payment);
    if (m && !means.some((x) => x.code === m.code && x.text === m.text)) means.push(m);
  }

  const due = order.totalWithTax - prepaidAmount;
  const { seller, buyer } = input;
  if (due > 0 && seller.bank && !means.some((m) => m.code === '58')) {
    means.push({ code: '58', ...seller.bank });
  }

  return {
    schemaVersion: 1,
    type: 'invoice',
    number: '',
    issueDate: input.issueDate,
    currencyCode: order.currencyCode,
    amountDecimals: input.amountDecimals,
    language: input.language,
    buyerReference: buyer.buyerReference,
    orderReference: buyer.orderReference,
    salesOrderReference: order.code,
    precedingInvoices: [],
    deliveryDate: input.deliveryDate,
    notes: buyer.notes ?? [],
    seller: seller.seller,
    buyer: buyer.buyer,
    delivery: buyer.delivery,
    lines,
    allowances,
    charges,
    payment: {
      means,
      terms: due > 0 ? seller.paymentTerms : undefined,
      dueDate: due > 0 && seller.paymentTermDays !== undefined ? addDays(input.issueDate, seller.paymentTermDays) : undefined,
      prepaidAmount,
    },
    taxCalculation: input.taxCalculation,
    meta: {
      orderId: String(order.id),
      orderCode: order.code,
      channelCode: input.channelCode,
      pricesIncludeTax: input.pricesIncludeTax,
      priceDisplay: input.priceDisplay,
    },
  };
}

function mapLine(input: BuildModelInput, line: OrderLine, index: number, labels: ReturnType<typeof mappingLabels>): InvoiceLine {
  const quantity = line.quantity;
  const netUnitPrice = line.unitPrice;
  const netAmount = line.proratedLinePrice;
  const allowances: AllowanceCharge[] = [];
  const charges: AllowanceCharge[] = [];

  // Promotions (item promotions and prorated order promotions)
  const discount = line.linePrice - netAmount;
  const discountReason = [...new Set(line.discounts.map((d) => d.description).filter(Boolean))].join(', ') || labels.discount;
  if (discount > 0) allowances.push({ amount: discount, reason: discountReason });
  else if (discount < 0) charges.push({ amount: -discount, reason: discountReason });

  // Gross-price channels: the net unit price is rounded, so quantity × unit price can differ from the line price
  const rounding = netUnitPrice * quantity - line.linePrice;
  if (rounding > 0) allowances.push({ amount: rounding, reason: labels.rounding, rounding: true });
  else if (rounding < 0) charges.push({ amount: -rounding, reason: labels.rounding, rounding: true });

  return {
    id: String(index + 1),
    orderLineId: String(line.id),
    name: input.lineName(line),
    sellerItemId: line.productVariant?.sku || undefined,
    quantity: String(quantity),
    unitCode: input.unitCode(line),
    netUnitPrice,
    allowances,
    charges,
    netAmount,
    vat: input.lineCategory(line),
    vendureTaxAmount: line.proratedLinePriceWithTax - netAmount,
    display: { grossUnitPrice: line.unitPriceWithTax, grossAmount: line.proratedLinePriceWithTax },
  };
}

function surchargeTax(surcharge: Surcharge): number {
  return surcharge.priceWithTax - surcharge.price;
}

/** A VAT rate as Vendure stores it (number) → decimal string. */
export function rateToDecimal(rate: number): string {
  // Rates are stored as decimals with at most a few places; toFixed(6) removes binary noise like 7.000000000001
  return normalizeDecimal(rate.toFixed(6));
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Calendar date of `date` in the given IANA time zone. */
export function isoDateInZone(date: Date, timeZone: string): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
