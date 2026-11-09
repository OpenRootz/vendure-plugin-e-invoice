import { EInvoiceModel, InvoiceLine, VatCategory } from '../../src/core';

export const VAT_19: VatCategory = { code: 'S', rate: '19' };
export const VAT_7: VatCategory = { code: 'S', rate: '7' };

let lineSeq = 0;
/** A line without allowances; netAmount = qty × price. */
export function line(netUnitPrice: number, quantity = '1', vat: VatCategory = VAT_19, extra: Partial<InvoiceLine> = {}): InvoiceLine {
  lineSeq++;
  return {
    id: String(lineSeq),
    name: `Product ${lineSeq}`,
    quantity,
    unitCode: 'H87',
    netUnitPrice,
    allowances: [],
    charges: [],
    netAmount: netUnitPrice * Number(quantity),
    vat,
    ...extra,
  };
}

/** A complete, valid B2B invoice skeleton (seller/buyer filled in); override what the test needs. */
export function model(overrides: Partial<EInvoiceModel> = {}): EInvoiceModel {
  return {
    schemaVersion: 1,
    type: 'invoice',
    number: 'RE-2026-00001',
    issueDate: '2026-11-09',
    currencyCode: 'EUR',
    amountDecimals: 2,
    language: 'de',
    buyerReference: 'ABC123',
    salesOrderReference: 'ABC123',
    precedingInvoices: [],
    deliveryDate: '2026-11-08',
    notes: [],
    seller: {
      name: 'Demo Shop GmbH',
      address: { line1: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE' },
      vatId: 'DE123456789',
      contact: { name: 'Buchhaltung', phone: '+49 30 1234567', email: 'buchhaltung@example.com' },
      electronicAddress: { scheme: 'EM', value: 'rechnung@example.com' },
    },
    buyer: {
      name: 'Beispiel Kunde AG',
      isBusiness: true,
      address: { line1: 'Kundenweg 7', postalCode: '80331', city: 'München', countryCode: 'DE' },
      electronicAddress: { scheme: 'EM', value: 'einkauf@example.org' },
    },
    lines: [],
    allowances: [],
    charges: [],
    payment: { means: [{ code: '58', iban: 'DE02120300000000202051' }], terms: '14 Tage netto', prepaidAmount: 0 },
    taxCalculation: 'vendure',
    meta: { orderId: '1', orderCode: 'ABC123', channelCode: 'default', pricesIncludeTax: false, priceDisplay: 'net' },
    ...overrides,
  };
}
