import { Decimal, IsoDate, Money } from '../model';
import { formatAmount, normalizeDecimal } from '../money';

/** Texts of the default PDF template. Override single labels per language via the plugin options. */
export interface PdfLabels {
  /** BCP 47 locale for number and date formatting, e.g. `de-DE` */
  locale: string;
  invoice: string;
  creditNote: string;
  /** Placeholder number of a preview that has not been issued */
  draft: string;
  invoiceNumber: string;
  creditNoteNumber: string;
  invoiceDate: string;
  deliveryDate: string;
  deliveryAddress: string;
  orderNumber: string;
  purchaseOrder: string;
  buyerReference: string;
  buyerVatId: string;
  correctsInvoice: string;
  position: string;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
  amount: string;
  itemNumber: string;
  net: string;
  gross: string;
  totalNet: string;
  vat: string;
  vatOn: string;
  total: string;
  rounding: string;
  prepaid: string;
  amountDue: string;
  payment: string;
  dueDate: string;
  transferTo: string;
  reference: string;
  paidWith: string;
  alreadyPaid: string;
  refundTotal: string;
  refunded: string;
  /** Credit note that is offset against a new invoice (cancel and reissue) */
  offset: string;
  directDebit: string;
  page: string;
  of: string;
  vatId: string;
  taxNumber: string;
  phone: string;
  email: string;
  units: Record<string, string>;
}

export const DEFAULT_LABELS: Record<string, PdfLabels> = {
  de: {
    locale: 'de-DE',
    invoice: 'Rechnung',
    creditNote: 'Rechnungskorrektur',
    draft: 'ENTWURF',
    invoiceNumber: 'Rechnungsnummer',
    creditNoteNumber: 'Korrekturnummer',
    invoiceDate: 'Rechnungsdatum',
    deliveryDate: 'Liefer-/Leistungsdatum',
    deliveryAddress: 'Lieferanschrift',
    orderNumber: 'Bestellnummer',
    purchaseOrder: 'Ihre Bestellung',
    buyerReference: 'Ihre Referenz',
    buyerVatId: 'Ihre USt-IdNr.',
    correctsInvoice: 'Korrektur zur Rechnung {number} vom {date}',
    position: 'Pos.',
    description: 'Bezeichnung',
    quantity: 'Menge',
    unitPrice: 'Einzelpreis',
    vatRate: 'USt.',
    amount: 'Betrag',
    itemNumber: 'Art.-Nr.',
    net: 'netto',
    gross: 'brutto',
    totalNet: 'Summe netto',
    vat: 'USt.',
    vatOn: 'auf',
    total: 'Gesamtbetrag',
    rounding: 'Rundung',
    prepaid: 'Bereits bezahlt',
    amountDue: 'Zu zahlen',
    payment: 'Zahlung',
    dueDate: 'Fällig am {date}.',
    transferTo: 'Bitte überweisen Sie den Betrag auf folgendes Konto:',
    reference: 'Verwendungszweck',
    paidWith: 'Bezahlt mit {method}.',
    alreadyPaid: 'Der Rechnungsbetrag wurde bereits beglichen.',
    refundTotal: 'Erstattungsbetrag',
    refunded: 'Der Betrag wird Ihnen über die ursprüngliche Zahlungsart erstattet.',
    offset: 'Diese Rechnungskorrektur storniert die oben genannte Rechnung. Der Betrag wird mit der neuen Rechnung verrechnet.',
    directDebit: 'Der Betrag wird per SEPA-Lastschrift eingezogen (Mandat {mandate}, Gläubiger-ID {creditor}).',
    page: 'Seite',
    of: 'von',
    vatId: 'USt-IdNr.',
    taxNumber: 'Steuernummer',
    phone: 'Tel.',
    email: 'E-Mail',
    units: {
      H87: 'Stk.',
      C62: 'Stk.',
      XPP: 'Stk.',
      KGM: 'kg',
      GRM: 'g',
      LTR: 'l',
      MTR: 'm',
      MTK: 'm²',
      HUR: 'Std.',
      DAY: 'Tag(e)',
      MON: 'Monat(e)',
      SET: 'Set',
    },
  },
  en: {
    locale: 'en-GB',
    invoice: 'Invoice',
    creditNote: 'Credit note',
    draft: 'DRAFT',
    invoiceNumber: 'Invoice number',
    creditNoteNumber: 'Credit note number',
    invoiceDate: 'Invoice date',
    deliveryDate: 'Delivery date',
    deliveryAddress: 'Delivery address',
    orderNumber: 'Order number',
    purchaseOrder: 'Your order',
    buyerReference: 'Your reference',
    buyerVatId: 'Your VAT ID',
    correctsInvoice: 'Correction of invoice {number} dated {date}',
    position: 'No.',
    description: 'Description',
    quantity: 'Qty',
    unitPrice: 'Unit price',
    vatRate: 'VAT',
    amount: 'Amount',
    itemNumber: 'Item no.',
    net: 'net',
    gross: 'gross',
    totalNet: 'Total net',
    vat: 'VAT',
    vatOn: 'on',
    total: 'Total',
    rounding: 'Rounding',
    prepaid: 'Already paid',
    amountDue: 'Amount due',
    payment: 'Payment',
    dueDate: 'Due on {date}.',
    transferTo: 'Please transfer the amount to the following account:',
    reference: 'Reference',
    paidWith: 'Paid with {method}.',
    alreadyPaid: 'The invoice amount has already been paid.',
    refundTotal: 'Refund amount',
    refunded: 'The amount will be refunded via the original payment method.',
    offset: 'This credit note cancels the invoice referenced above. The amount is offset against the new invoice.',
    directDebit: 'The amount will be collected by SEPA direct debit (mandate {mandate}, creditor ID {creditor}).',
    page: 'Page',
    of: 'of',
    vatId: 'VAT ID',
    taxNumber: 'Tax number',
    phone: 'Phone',
    email: 'Email',
    units: {
      H87: 'pcs',
      C62: 'pcs',
      XPP: 'pcs',
      KGM: 'kg',
      GRM: 'g',
      LTR: 'l',
      MTR: 'm',
      MTK: 'm²',
      HUR: 'h',
      DAY: 'day(s)',
      MON: 'month(s)',
      SET: 'set',
    },
  },
};

/** Labels for a language (`de`, `de-AT`, `en`, …), with overrides; falls back to English. */
export function pdfLabels(language: string, overrides: Record<string, Partial<PdfLabels>> = {}): PdfLabels {
  const lang = language.split(/[-_]/)[0].toLowerCase();
  // Own properties only: a language like `constructor` must not pick up something inherited from Object.prototype
  const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);
  const base = own(DEFAULT_LABELS, lang) ?? DEFAULT_LABELS.en;
  const override = own(overrides, language) ?? own(overrides, lang) ?? {};
  return { ...base, ...override, units: { ...base.units, ...override.units } };
}

export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key) => values[key] ?? m);
}

/** Formatting helpers bound to a locale and currency. Amounts are converted with string math, never float arithmetic. */
export function formatters(labels: PdfLabels, currencyCode: string, amountDecimals: number) {
  const currency = new Intl.NumberFormat(labels.locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: amountDecimals,
    maximumFractionDigits: amountDecimals,
  });
  const decimal = new Intl.NumberFormat(labels.locale, { maximumFractionDigits: 6 });
  const date = new Intl.DateTimeFormat(labels.locale, { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });
  return {
    // Number() of an exact decimal string is only used for display formatting with a fixed number of decimals
    money: (amount: Money) => currency.format(Number(formatAmount(amount, amountDecimals))),
    decimal: (value: Decimal) => decimal.format(Number(normalizeDecimal(value))),
    percent: (rate: Decimal) => `${decimal.format(Number(normalizeDecimal(rate)))} %`,
    date: (value: IsoDate) => date.format(new Date(`${value}T00:00:00Z`)),
    unit: (code: string) => labels.units[code] ?? code,
  };
}

export type Formatters = ReturnType<typeof formatters>;
