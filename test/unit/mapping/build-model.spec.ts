import { AdjustmentType, Order, OrderLine, Payment, ShippingLine, Surcharge } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import { calculate, checkModel, toCii, toUbl, VatCategory } from '../../../src/core';
import { addDays, buildModel, BuildModelInput, isoDateInZone, rateToDecimal } from '../../../src/mapping/build-model';
import { categoryFromTaxRate } from '../../../src/mapping/order-model.mapper';
import { DefaultBuyerDataStrategy } from '../../../src/strategies/buyer-data-strategy';
import { SellerData } from '../../../src/strategies/types';

const seller: SellerData = {
  seller: {
    name: 'Demo Shop GmbH',
    address: { line1: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE' },
    vatId: 'DE123456789',
    contact: { name: 'Buchhaltung', phone: '+49 30 1234567', email: 'buchhaltung@example.com' },
    electronicAddress: { scheme: 'EM', value: 'rechnung@example.com' },
  },
  bank: { iban: 'DE02120300000000202051', bic: 'BYLADEM1001' },
  paymentTerms: '14 Tage netto',
  paymentTermDays: 14,
};

let id = 0;
interface LineSpec {
  sku: string;
  price: number;
  qty: number;
  rate?: number;
  promotion?: { amount: number; description: string; type?: AdjustmentType };
}

function orderLine(s: LineSpec, gross: boolean): OrderLine {
  return new OrderLine({
    id: ++id,
    quantity: s.qty,
    orderPlacedQuantity: s.qty,
    listPrice: s.price,
    listPriceIncludesTax: gross,
    taxLines: [{ description: 'tax', taxRate: s.rate ?? 19 }],
    adjustments: s.promotion
      ? [
          {
            amount: -s.promotion.amount,
            adjustmentSource: `PROMOTION:${s.promotion.description}`,
            description: s.promotion.description,
            type: s.promotion.type ?? AdjustmentType.PROMOTION,
          },
        ]
      : [],
    productVariant: { sku: s.sku, name: s.sku } as never,
  });
}

interface OrderSpec {
  gross?: boolean;
  lines: LineSpec[];
  shipping?: { price: number; rate?: number; discount?: number };
  surcharges?: { price: number; description: string }[];
  /** Settled payment amount; default: the order total */
  paid?: number;
  paymentState?: string;
}

/** An order whose stored totals are consistent with its lines, as Vendure's OrderCalculator would leave it. */
function order(spec: OrderSpec): Order {
  const gross = spec.gross ?? false;
  const lines = spec.lines.map((l) => orderLine(l, gross));
  const shippingLines = spec.shipping
    ? [
        new ShippingLine({
          listPrice: spec.shipping.price,
          listPriceIncludesTax: gross,
          taxLines: [{ description: 'shipping tax', taxRate: spec.shipping.rate ?? 19 }],
          adjustments: spec.shipping.discount
            ? [{ amount: -spec.shipping.discount, adjustmentSource: 'PROMOTION:1', description: 'Free shipping', type: AdjustmentType.PROMOTION }]
            : [],
          shippingMethod: { name: 'DHL Paket' } as never,
        }),
      ]
    : [];
  const surcharges = (spec.surcharges ?? []).map(
    (s) => new Surcharge({ listPrice: s.price, listPriceIncludesTax: gross, description: s.description, sku: '', taxLines: [{ description: 'tax', taxRate: 19 }] }),
  );
  const o = new Order({
    id: 1,
    code: 'ABC123',
    currencyCode: 'EUR' as never,
    lines,
    shippingLines,
    surcharges,
    subTotal: sum(lines.map((l) => l.proratedLinePrice)) + sum(surcharges.map((s) => s.price)),
    subTotalWithTax: sum(lines.map((l) => l.proratedLinePriceWithTax)) + sum(surcharges.map((s) => s.priceWithTax)),
    shipping: sum(shippingLines.map((s) => s.discountedPrice)),
    shippingWithTax: sum(shippingLines.map((s) => s.discountedPriceWithTax)),
    billingAddress: { company: 'Beispiel Kunde AG', streetLine1: 'Kundenweg 7', postalCode: '80331', city: 'München', countryCode: 'DE' },
    shippingAddress: {},
    customFields: {} as never,
    customer: { emailAddress: 'einkauf@example.org', customFields: {} } as never,
  });
  o.payments = [
    new Payment({ amount: spec.paid ?? o.totalWithTax, state: (spec.paymentState ?? 'Settled') as never, method: 'test-payment' }),
  ];
  return o;
}

const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

async function build(o: Order, overrides: Partial<BuildModelInput> = {}) {
  const buyer = await new DefaultBuyerDataStrategy().getBuyer({} as never, o);
  const category = (rate: number): VatCategory => categoryFromTaxRate(rate, undefined);
  const model = buildModel({
    order: o,
    seller,
    buyer,
    channelCode: 'default',
    pricesIncludeTax: false,
    issueDate: '2026-11-09',
    deliveryDate: '2026-11-09',
    language: 'de',
    amountDecimals: 2,
    taxCalculation: 'vendure',
    priceDisplay: 'net',
    lineCategory: (line) => category(line.taxRate),
    otherCategory: category,
    paymentMeans: () => ({ code: '48', text: 'Karte' }),
    unitCode: () => 'H87',
    lineName: (line) => line.productVariant.sku,
    shippingName: (sl) => sl.shippingMethod?.name,
    ...overrides,
  });
  model.number = 'RE-2026-00001';
  model.totals = calculate(model, { expectedTotalWithTax: o.totalWithTax });
  return model;
}

/** The mapped invoice is consistent and every serializer accepts it. */
function expectValid(model: Awaited<ReturnType<typeof build>>) {
  expect(checkModel(model, ['zugferd', 'xrechnung-cii', 'xrechnung-ubl']).filter((i) => i.code !== 'BUYER_REFERENCE_MISSING')).toEqual([]);
  expect(model.totals?.expectedTotalDifference).toBe(0);
  expect(() => [toCii(model, 'zugferd'), toCii(model, 'xrechnung'), toUbl(model)]).not.toThrow();
}

describe('buildModel', () => {
  it('maps a net order with shipping: net prices, shipping as FC charge, prepaid = paid', async () => {
    const o = order({
      lines: [
        { sku: 'KAF-500', price: 1000, qty: 2 },
        { sku: 'BOOK-1', price: 1869, qty: 1, rate: 7 },
      ],
      shipping: { price: 490 },
    });
    const m = await build(o);
    expect(m.lines.map((l) => [l.sellerItemId, l.quantity, l.netUnitPrice, l.netAmount, l.vat.rate, l.vendureTaxAmount])).toEqual([
      ['KAF-500', '2', 1000, 2000, '19', 380],
      ['BOOK-1', '1', 1869, 1869, '7', 131],
    ]);
    expect(m.charges).toEqual([{ amount: 490, reason: 'DHL Paket', reasonCode: 'FC', vat: { code: 'S', rate: '19' }, vendureTaxAmount: 93 }]);
    expect(m.salesOrderReference).toBe('ABC123');
    expect(m.buyer).toMatchObject({ name: 'Beispiel Kunde AG', isBusiness: true, electronicAddress: { scheme: 'EM', value: 'einkauf@example.org' } });
    expect(m.payment).toMatchObject({ prepaidAmount: o.totalWithTax, means: [{ code: '48' }] });
    expect(m.payment.terms).toBeUndefined();
    expect(m.totals?.duePayable).toBe(0);
    expectValid(m);
  });

  it('turns item promotions and prorated order promotions into line allowances', async () => {
    const o = order({
      lines: [
        { sku: 'KAF-500', price: 1000, qty: 2, promotion: { amount: 200, description: '10 % Herbstrabatt' } },
        { sku: 'NB-A5', price: 335, qty: 1, promotion: { amount: 34, description: 'Bestellrabatt', type: AdjustmentType.DISTRIBUTED_ORDER_PROMOTION } },
      ],
    });
    const m = await build(o);
    expect(m.lines[0]).toMatchObject({ netUnitPrice: 1000, netAmount: 1800, allowances: [{ amount: 200, reason: '10 % Herbstrabatt' }], charges: [] });
    expect(m.lines[1]).toMatchObject({ netUnitPrice: 335, netAmount: 301, allowances: [{ amount: 34, reason: 'Bestellrabatt' }] });
    expectValid(m);
  });

  it('keeps line amounts exact in gross-price channels with a rounding allowance or charge', async () => {
    // 3.99 gross → 3.3529… net: unit price 3.35, but the line price for 3 pieces is round(10.0588) = 10.06
    const o = order({ gross: true, lines: [{ sku: 'NB-A5', price: 399, qty: 3 }, { sku: 'KS-3', price: 499, qty: 1 }] });
    const m = await build(o, { pricesIncludeTax: true, priceDisplay: 'gross' });
    expect(m.lines[0]).toMatchObject({
      netUnitPrice: 335,
      netAmount: 1006,
      allowances: [],
      charges: [{ amount: 1, reason: 'Rundungsdifferenz' }],
      display: { grossUnitPrice: 399, grossAmount: 1197 },
    });
    expect(m.totals?.grandTotal).toBe(1197 + 499);
    expectValid(m);
  });

  it('omits free shipping and maps surcharges (negative ones as allowances)', async () => {
    const o = order({
      lines: [{ sku: 'KAF-500', price: 1000, qty: 1 }],
      shipping: { price: 490, discount: 490 },
      surcharges: [
        { price: 200, description: 'Expresszuschlag' },
        { price: -100, description: 'Abholrabatt' },
      ],
    });
    const m = await build(o);
    expect(m.charges).toEqual([{ amount: 200, reason: 'Expresszuschlag', vat: { code: 'S', rate: '19' }, vendureTaxAmount: 38 }]);
    expect(m.allowances).toEqual([{ amount: 100, reason: 'Abholrabatt', vat: { code: 'S', rate: '19' }, vendureTaxAmount: 19 }]);
    expectValid(m);
  });

  it('adds SEPA credit transfer, terms and due date when an amount is still due', async () => {
    const o = order({ lines: [{ sku: 'KAF-500', price: 1000, qty: 1 }], paid: 0, paymentState: 'Authorized' });
    const m = await build(o);
    expect(m.payment).toMatchObject({
      prepaidAmount: 0,
      terms: '14 Tage netto',
      dueDate: '2026-11-23',
      means: [{ code: '48' }, { code: '58', iban: 'DE02120300000000202051', bic: 'BYLADEM1001' }],
    });
    expect(m.totals?.duePayable).toBe(1190);
    expectValid(m);
  });

  it('skips cancelled lines (quantity 0)', async () => {
    const o = order({ lines: [{ sku: 'KAF-500', price: 1000, qty: 1 }, { sku: 'NB-A5', price: 335, qty: 0 }] });
    const m = await build(o);
    expect(m.lines.map((l) => l.sellerItemId)).toEqual(['KAF-500']);
  });
});

describe('mapping helpers', () => {
  it('derives the VAT category from the tax rate custom fields', () => {
    expect(categoryFromTaxRate(19, undefined)).toEqual({ code: 'S', rate: '19' });
    expect(categoryFromTaxRate(0, undefined)).toEqual({ code: 'S', rate: '0' });
    const k = { customFields: { eInvoiceCategoryCode: 'K', eInvoiceExemptionReasonCode: 'VATEX-EU-IC' } } as never;
    expect(categoryFromTaxRate(0, k)).toEqual({ code: 'K', rate: '0', exemptionReasonCode: 'VATEX-EU-IC' });
  });

  it('converts rates without float noise', () => {
    expect(rateToDecimal(19)).toBe('19');
    expect(rateToDecimal(5.5)).toBe('5.5');
    expect(rateToDecimal(0.1 + 0.2)).toBe('0.3');
  });

  it('computes dates', () => {
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
    expect(isoDateInZone(new Date('2026-12-31T23:30:00Z'), 'Europe/Berlin')).toBe('2027-01-01');
    expect(isoDateInZone(new Date('2026-12-31T23:30:00Z'), 'UTC')).toBe('2026-12-31');
  });
});

describe('DefaultBuyerDataStrategy', () => {
  const strategy = new DefaultBuyerDataStrategy();
  const base = (extra: Partial<Order>) =>
    ({
      code: 'XYZ',
      billingAddress: { fullName: 'Erika Mustermann', streetLine1: 'Hauptstraße 3', postalCode: '50667', city: 'Köln', countryCode: 'de' },
      shippingAddress: { fullName: 'Erika Mustermann', streetLine1: 'Hauptstraße 3', postalCode: '50667', city: 'Köln', countryCode: 'DE' },
      customFields: {},
      customer: { emailAddress: 'erika@example.net', customFields: {} },
      ...extra,
    }) as unknown as Order;

  it('maps a private customer with the order code as buyer reference', async () => {
    const b = await strategy.getBuyer({} as never, base({}));
    expect(b.buyer).toMatchObject({ name: 'Erika Mustermann', isBusiness: false, address: { countryCode: 'DE' } });
    expect(b.buyerReference).toBe('XYZ');
    expect(b.delivery).toBeUndefined();
    expect(b.leitwegId).toBeUndefined();
  });

  it('uses the Leitweg-ID as buyer reference and electronic address; order fields override customer fields', async () => {
    const b = await strategy.getBuyer(
      {} as never,
      base({
        customFields: { eInvoiceLeitwegId: ' 991-12345-67 ', eInvoiceVatId: 'DE111' } as never,
        customer: { emailAddress: 'x@example.org', customFields: { eInvoiceVatId: 'DE222', eInvoiceBuyerReference: 'KST-1' } } as never,
      }),
    );
    expect(b.buyerReference).toBe('991-12345-67');
    expect(b.buyer.electronicAddress).toEqual({ scheme: '0204', value: '991-12345-67' });
    expect(b.buyer.vatId).toBe('DE111');
    expect(b.buyer.isBusiness).toBe(true);
  });

  it('adds a delivery address only when it differs from the billing address', async () => {
    const b = await strategy.getBuyer(
      {} as never,
      base({ shippingAddress: { fullName: 'Lager', streetLine1: 'Lagerstraße 12', postalCode: '85748', city: 'Garching', countryCode: 'DE' } as never }),
    );
    expect(b.delivery).toEqual({ name: 'Lager', address: expect.objectContaining({ line1: 'Lagerstraße 12', city: 'Garching' }) });
  });
});
