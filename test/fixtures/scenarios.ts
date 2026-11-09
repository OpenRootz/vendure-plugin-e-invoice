import { calculate, EInvoiceFormat, EInvoiceModel, InvoiceLine, Money, VatCategory } from '../../src/core';
import { model, VAT_19, VAT_7 } from './model-builders';

/**
 * Invoice scenarios covering the mapping decisions. Each one is serialized to every format,
 * compared with the golden files in `test/golden/` and validated with KoSIT in CI.
 */
export interface Scenario {
  name: string;
  description: string;
  model: EInvoiceModel;
  /** What the customer was charged (Vendure order total), if relevant */
  expectedTotalWithTax?: Money;
  formats: EInvoiceFormat[];
}

const ALL_FORMATS: EInvoiceFormat[] = ['zugferd', 'xrechnung-cii', 'xrechnung-ubl'];

interface LineInput {
  name: string;
  sku?: string;
  qty?: string;
  price: Money;
  vat?: VatCategory;
  tax?: Money;
  allowance?: { amount: Money; reason: string };
  gtin?: string;
  description?: string;
}

function lines(inputs: LineInput[]): InvoiceLine[] {
  return inputs.map((l, i) => {
    const qty = l.qty ?? '1';
    const gross = l.price * Number(qty);
    return {
      id: String(i + 1),
      name: l.name,
      sellerItemId: l.sku,
      gtin: l.gtin,
      description: l.description,
      quantity: qty,
      unitCode: 'H87',
      netUnitPrice: l.price,
      allowances: l.allowance ? [{ amount: l.allowance.amount, reason: l.allowance.reason }] : [],
      charges: [],
      netAmount: gross - (l.allowance?.amount ?? 0),
      vat: l.vat ?? VAT_19,
      vendureTaxAmount: l.tax,
    };
  });
}

function scenario(s: Omit<Scenario, 'formats'> & { formats?: EInvoiceFormat[] }): Scenario {
  s.model.totals = calculate(s.model, { expectedTotalWithTax: s.expectedTotalWithTax });
  return { formats: ALL_FORMATS, ...s };
}

const b2bBuyer = () => ({
  name: 'Beispiel Kunde AG',
  isBusiness: true,
  vatId: 'DE987654321',
  address: { line1: 'Kundenweg 7', postalCode: '80331', city: 'München', countryCode: 'DE' },
  electronicAddress: { scheme: 'EM', value: 'einkauf@example.org' },
  contact: { name: 'Max Einkauf', email: 'einkauf@example.org' },
});

export const scenarios: Scenario[] = [
  scenario({
    name: 'b2b-net',
    description: 'B2B net channel: line allowance, shipping as document charge, SEPA credit transfer with due date',
    expectedTotalWithTax: 3320,
    model: model({
      buyer: b2bBuyer(),
      orderReference: 'PO-4711',
      lines: lines([
        {
          name: 'Bio-Kaffee 500g',
          sku: 'KAF-500',
          gtin: '4012345678901',
          qty: '2',
          price: 1000,
          tax: 342,
          allowance: { amount: 200, reason: 'Promotion: 10 % Herbstrabatt' },
        },
        { name: 'Teefilter (100 Stk.)', sku: 'TF-100', price: 500, tax: 95 },
      ]),
      charges: [{ amount: 490, reason: 'DHL Paket', reasonCode: 'FC', vat: VAT_19, vendureTaxAmount: 93 }],
      payment: {
        means: [{ code: '58', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', accountName: 'Demo Shop GmbH' }],
        terms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
        dueDate: '2026-11-23',
        prepaidAmount: 0,
        reference: 'RE-2026-00001',
      },
    }),
  }),

  scenario({
    name: 'b2c-gross-vendure-tax',
    description: 'B2C gross channel, card payment; VAT = sum of Vendure line taxes (default), no rounding amount',
    expectedTotalWithTax: 1497,
    model: model({
      buyer: {
        name: 'Erika Mustermann',
        isBusiness: false,
        address: { line1: 'Hauptstraße 3', postalCode: '50667', city: 'Köln', countryCode: 'DE' },
        electronicAddress: { scheme: 'EM', value: 'erika@example.net' },
      },
      lines: lines([
        { name: 'Notizbuch A5', sku: 'NB-A5', price: 335, tax: 64 },
        { name: 'Kugelschreiber Set', sku: 'KS-3', price: 419, tax: 80 },
        { name: 'Textmarker 4er', sku: 'TM-4', price: 503, tax: 96 },
      ]),
      payment: { means: [{ code: '48', cardLast4: '1234', cardNetwork: 'VISA' }], prepaidAmount: 1497 },
      meta: { orderId: '2', orderCode: 'XYZ789', channelCode: 'default', pricesIncludeTax: true, priceDisplay: 'gross' },
    }),
  }),

  scenario({
    name: 'b2c-gross-en16931-rounding',
    description: 'Same order with taxCalculation en16931: VAT on the sum plus rounding amount BT-114',
    expectedTotalWithTax: 1497,
    model: model({
      taxCalculation: 'en16931',
      buyer: {
        name: 'Erika Mustermann',
        isBusiness: false,
        address: { line1: 'Hauptstraße 3', postalCode: '50667', city: 'Köln', countryCode: 'DE' },
        electronicAddress: { scheme: 'EM', value: 'erika@example.net' },
      },
      lines: lines([
        { name: 'Notizbuch A5', sku: 'NB-A5', price: 335, tax: 64 },
        { name: 'Kugelschreiber Set', sku: 'KS-3', price: 419, tax: 80 },
        { name: 'Textmarker 4er', sku: 'TM-4', price: 503, tax: 96 },
      ]),
      payment: { means: [{ code: '48', cardLast4: '1234', cardNetwork: 'VISA' }], prepaidAmount: 1497 },
    }),
  }),

  scenario({
    name: 'mixed-rates',
    description: '19 % + 7 % + zero rated, notes, separate delivery address, online payment service',
    model: model({
      buyer: b2bBuyer(),
      notes: ['Vielen Dank für Ihren Einkauf!'],
      delivery: {
        name: 'Beispiel Kunde AG – Lager',
        address: { line1: 'Lagerstraße 12', line2: 'Tor 3', postalCode: '85748', city: 'Garching', countryCode: 'DE' },
      },
      lines: lines([
        { name: 'Bio-Kaffee 500g', sku: 'KAF-500', price: 1000, tax: 190 },
        { name: 'Fachbuch E-Rechnung', sku: 'BOOK-1', price: 1869, vat: VAT_7, tax: 131, description: 'Gebundene Ausgabe' },
        { name: 'Solarmodul 400 W', sku: 'PV-400', price: 18900, vat: { code: 'Z', rate: '0' }, tax: 0 },
      ]),
      charges: [{ amount: 490, reason: 'DHL Paket', reasonCode: 'FC', vat: VAT_19, vendureTaxAmount: 93 }],
      payment: { means: [{ code: '68', text: 'PayPal' }], prepaidAmount: 22673 },
    }),
  }),

  scenario({
    name: 'reverse-charge-ae',
    description: 'Service to an EU business customer: reverse charge (AE), SEPA direct debit',
    model: model({
      buyer: {
        name: 'Exemple SARL',
        isBusiness: true,
        vatId: 'FR40303265045',
        address: { line1: '12 Rue de la Paix', postalCode: '75002', city: 'Paris', countryCode: 'FR' },
        electronicAddress: { scheme: 'EM', value: 'compta@example.fr' },
      },
      lines: lines([
        {
          name: 'Beratung E-Rechnung (Stunden)',
          sku: 'CONSULT',
          qty: '3',
          price: 12000,
          vat: { code: 'AE', rate: '0', exemptionReason: 'Steuerschuldnerschaft des Leistungsempfängers', exemptionReasonCode: 'VATEX-EU-AE' },
          tax: 0,
        },
      ]),
      payment: {
        means: [{ code: '59', mandateReference: 'MANDATE-0815', creditorId: 'DE98ZZZ09999999999', debtorIban: 'FR7630006000011234567890189' }],
        terms: 'Der Betrag wird am Fälligkeitstag per SEPA-Lastschrift eingezogen.',
        dueDate: '2026-11-16',
        prepaidAmount: 0,
      },
    }),
  }),

  scenario({
    name: 'intra-community-k',
    description: 'Goods delivered to an Austrian business customer: intra-community supply (K)',
    model: model({
      buyer: {
        name: 'Beispiel Handel GmbH',
        isBusiness: true,
        vatId: 'ATU12345678',
        address: { line1: 'Ringstraße 1', postalCode: '1010', city: 'Wien', countryCode: 'AT' },
        electronicAddress: { scheme: 'EM', value: 'buchhaltung@example.at' },
      },
      delivery: {
        name: 'Beispiel Handel GmbH',
        address: { line1: 'Ringstraße 1', postalCode: '1010', city: 'Wien', countryCode: 'AT' },
      },
      lines: lines([
        {
          name: 'Bio-Kaffee 500g',
          sku: 'KAF-500',
          qty: '24',
          price: 1000,
          vat: { code: 'K', rate: '0', exemptionReason: 'Steuerfreie innergemeinschaftliche Lieferung', exemptionReasonCode: 'VATEX-EU-IC' },
          tax: 0,
        },
      ]),
      payment: { means: [{ code: '58', iban: 'DE02120300000000202051' }], terms: '30 Tage netto', dueDate: '2026-12-09', prepaidAmount: 0 },
    }),
  }),

  scenario({
    name: 'export-g',
    description: 'Export to Switzerland (G)',
    model: model({
      buyer: {
        name: 'Muster AG',
        isBusiness: true,
        address: { line1: 'Bahnhofstrasse 1', postalCode: '8001', city: 'Zürich', countryCode: 'CH' },
        electronicAddress: { scheme: 'EM', value: 'rechnungen@example.ch' },
      },
      lines: lines([
        {
          name: 'Bio-Kaffee 500g',
          sku: 'KAF-500',
          qty: '10',
          price: 1000,
          vat: { code: 'G', rate: '0', exemptionReason: 'Steuerfreie Ausfuhrlieferung', exemptionReasonCode: 'VATEX-EU-G' },
          tax: 0,
        },
      ]),
      payment: { means: [{ code: '58', iban: 'DE02120300000000202051' }], terms: '30 Tage netto', prepaidAmount: 0 },
    }),
  }),

  scenario({
    name: 'credit-note-partial',
    description: 'Partial credit note (381): one returned line plus a goodwill allowance, refunded to the card',
    model: model({
      type: 'credit_note',
      number: 'GS-2026-00001',
      issueDate: '2026-11-20',
      precedingInvoices: [{ number: 'RE-2026-00001', issueDate: '2026-11-09' }],
      buyer: b2bBuyer(),
      lines: lines([{ name: 'Teefilter (100 Stk.)', sku: 'TF-100', price: 500, tax: 95 }]),
      allowances: [{ amount: 300, reason: 'Kulanz', reasonCode: '95', vat: VAT_19 }],
      payment: { means: [{ code: '48', cardLast4: '1234', cardNetwork: 'VISA' }], prepaidAmount: 238 },
    }),
  }),

  scenario({
    name: 'seller-tax-number',
    description: 'Small business with tax number instead of VAT ID, commercial register and legal info',
    model: model({
      seller: {
        name: 'Kleiner Laden UG (haftungsbeschränkt)',
        tradingName: 'Kleiner Laden',
        address: { line1: 'Marktplatz 5', postalCode: '01067', city: 'Dresden', countryCode: 'DE' },
        taxNumber: '201/123/45678',
        legalRegistration: { id: 'HRB 12345' },
        legalInfo: 'Geschäftsführerin: Anna Beispiel · Amtsgericht Dresden HRB 12345',
        contact: { name: 'Anna Beispiel', phone: '+49 351 123456', email: 'anna@example.com' },
        electronicAddress: { scheme: 'EM', value: 'rechnung@example.com' },
      },
      buyer: b2bBuyer(),
      lines: lines([{ name: 'Geschenkbox', sku: 'BOX-1', price: 2521, tax: 479 }]),
      payment: { means: [{ code: '58', iban: 'DE02120300000000202051' }], terms: 'Zahlbar sofort ohne Abzug.', prepaidAmount: 0 },
    }),
  }),
];
