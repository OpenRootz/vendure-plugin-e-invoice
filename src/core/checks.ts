import { vatGroupKey } from './calculate';
import type { CreditNoteErrorCode } from './credit-note';
import { EInvoiceFormat, EInvoiceModel, InvoiceLine, Seller, VatCategory, VatCategoryCode } from './model';
import { isZeroDecimal, multiply, sum } from './money';

/**
 * Plausibility checks that run before an invoice number is reserved.
 * They catch problems with shop data or configuration and explain them in plain words,
 * instead of producing an invoice that a validator would reject later.
 */

export type IssueCode =
  | 'AMOUNT_PRECISION'
  | 'EMPTY_INVOICE'
  | 'INVALID_DATE'
  | 'SELLER_INCOMPLETE'
  | 'SELLER_TAX_ID_MISSING'
  | 'BUYER_INCOMPLETE'
  | 'BUYER_REFERENCE_MISSING'
  | 'BUYER_ELECTRONIC_ADDRESS_MISSING'
  | 'TAX_CATEGORY_MISSING'
  | 'INVALID_RATE_FOR_CATEGORY'
  | 'EXEMPTION_REASON_REQUIRED'
  | 'EXEMPTION_REASON_CONFLICT'
  | 'BUYER_VAT_ID_REQUIRED'
  | 'INTRA_COMMUNITY_SAME_COUNTRY'
  | 'DELIVERY_INFO_REQUIRED'
  | 'LINE_AMOUNT_MISMATCH'
  | 'NEGATIVE_AMOUNT'
  | 'TOTAL_MISMATCH'
  | 'OVERPAID'
  | 'PAYMENT_TERMS_REQUIRED'
  | 'PAYMENT_ACCOUNT_MISSING'
  | 'PAYMENT_MEANS_MISSING'
  | 'CREDIT_NOTE_REFERENCE_MISSING'
  | 'TOTALS_MISSING';

export interface InvoiceIssue {
  code: IssueCode | CreditNoteErrorCode;
  message: string;
  /** Path in the model, e.g. `lines[2].vat` */
  path?: string;
}

/** Categories with a 0 % rate that need an exemption reason (BR-E-10, BR-AE-10, BR-IC-10, BR-G-10, BR-O-10). */
const EXEMPT_CATEGORIES: VatCategoryCode[] = ['E', 'AE', 'K', 'G', 'O'];
/** Categories whose rate must be 0. */
const ZERO_RATE_CATEGORIES: VatCategoryCode[] = ['Z', 'E', 'AE', 'K', 'G', 'O'];
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const isBlank = (v: string | undefined | null) => v === undefined || v === null || v.trim() === '';

export function checkModel(model: EInvoiceModel, formats: EInvoiceFormat[]): InvoiceIssue[] {
  const issues: InvoiceIssue[] = [];
  const add = (code: IssueCode, message: string, path?: string) => issues.push({ code, message, path });
  const xrechnung = formats.some((f) => f.startsWith('xrechnung'));

  // --- document ---
  if (model.amountDecimals > 2) {
    add('AMOUNT_PRECISION', `Amounts have ${model.amountDecimals} decimals; EN 16931 allows at most 2`);
  }
  if (model.lines.length === 0) {
    add('EMPTY_INVOICE', 'The invoice has no lines', 'lines');
  }
  for (const [path, value] of [
    ['issueDate', model.issueDate],
    ['deliveryDate', model.deliveryDate],
    ['payment.dueDate', model.payment.dueDate],
  ] as const) {
    if (value !== undefined && !ISO_DATE_RE.test(value)) {
      add('INVALID_DATE', `${path} must be a date in the format YYYY-MM-DD, got "${value}"`, path);
    }
  }
  if (model.type === 'credit_note' && model.precedingInvoices.length === 0) {
    add('CREDIT_NOTE_REFERENCE_MISSING', 'A credit note must reference the invoice it corrects', 'precedingInvoices');
  }

  // --- seller (BG-4, BG-6) ---
  issues.push(...checkSeller(model.seller));
  const seller = model.seller;

  // --- buyer (BG-7) ---
  const buyer = model.buyer;
  const missingBuyer = [
    isBlank(buyer.name) && 'name',
    isBlank(buyer.address.city) && 'city',
    isBlank(buyer.address.countryCode) && 'country',
    // XRechnung additionally requires the postal code (BR-DE-9)
    xrechnung && isBlank(buyer.address.postalCode) && 'postal code',
  ].filter(Boolean);
  if (missingBuyer.length) {
    add('BUYER_INCOMPLETE', `Buyer data is incomplete: ${missingBuyer.join(', ')}`, 'buyer');
  }
  if (xrechnung && isBlank(model.buyerReference)) {
    add('BUYER_REFERENCE_MISSING', 'XRechnung requires a buyer reference (BT-10), e.g. the Leitweg-ID', 'buyerReference');
  }
  if (xrechnung && isBlank(buyer.electronicAddress?.value)) {
    add('BUYER_ELECTRONIC_ADDRESS_MISSING', 'XRechnung requires an electronic address of the buyer (BT-49)', 'buyer.electronicAddress');
  }

  // --- VAT categories ---
  const categories: { category: VatCategory | undefined; path: string }[] = [
    ...model.lines.map((l, i) => ({ category: l.vat, path: `lines[${i}].vat` })),
    ...model.charges.map((c, i) => ({ category: c.vat, path: `charges[${i}].vat` })),
    ...model.allowances.map((a, i) => ({ category: a.vat, path: `allowances[${i}].vat` })),
  ];
  const reasons = new Map<string, string>();
  for (const { category, path } of categories) {
    if (!category) {
      add('TAX_CATEGORY_MISSING', 'Document-level allowances and charges need a VAT category', path);
      continue;
    }
    const zero = isZeroDecimal(category.rate);
    if (category.code === 'S' && zero) {
      add('TAX_CATEGORY_MISSING', 'A 0 % rate needs an explicit VAT category (e.g. Z, E, AE, K, G); set it on the tax rate', path);
    } else if (ZERO_RATE_CATEGORIES.includes(category.code) && !zero) {
      add('INVALID_RATE_FOR_CATEGORY', `VAT category ${category.code} requires a rate of 0 %, got ${category.rate} %`, path);
    }
    if (EXEMPT_CATEGORIES.includes(category.code) && isBlank(category.exemptionReason) && isBlank(category.exemptionReasonCode)) {
      add('EXEMPTION_REASON_REQUIRED', `VAT category ${category.code} requires an exemption reason or VATEX code`, path);
    }
    const key = vatGroupKey(category);
    const reason = `${category.exemptionReasonCode ?? ''}|${category.exemptionReason ?? ''}`;
    if (reasons.has(key) && reasons.get(key) !== reason) {
      add('EXEMPTION_REASON_CONFLICT', `VAT category ${category.code} ${category.rate} % is used with different exemption reasons`, path);
    }
    reasons.set(key, reasons.get(key) ?? reason);
  }
  const usedCodes = new Set(categories.map((c) => c.category?.code));
  if ((usedCodes.has('AE') || usedCodes.has('K')) && isBlank(buyer.vatId)) {
    add('BUYER_VAT_ID_REQUIRED', 'Reverse charge (AE) and intra-community supplies (K) require the buyer VAT ID', 'buyer.vatId');
  }
  if (usedCodes.has('K')) {
    // BR-IC-11 / BR-IC-12: delivery date and deliver-to country are mandatory
    const missing = [!model.deliveryDate && 'delivery date', !model.delivery && 'delivery address'].filter(Boolean);
    if (missing.length) {
      add('DELIVERY_INFO_REQUIRED', `Intra-community supply (K) requires ${missing.join(' and ')}`, 'delivery');
    }
    const deliveryCountry = model.delivery?.address.countryCode ?? buyer.address.countryCode;
    if (deliveryCountry === seller.address.countryCode) {
      add('INTRA_COMMUNITY_SAME_COUNTRY', 'Intra-community supply (K) requires delivery to another EU country', 'delivery');
    }
  }

  // --- amounts ---
  model.lines.forEach((line, i) => checkLine(line, i, add));
  [...model.charges, ...model.allowances].forEach((ac) => {
    if (ac.amount < 0) add('NEGATIVE_AMOUNT', `Allowance/charge "${ac.reason}" has a negative amount`);
  });

  const totals = model.totals;
  if (!totals) {
    add('TOTALS_MISSING', 'Totals have not been calculated', 'totals');
    return issues;
  }
  if (totals.expectedTotalDifference !== 0) {
    add('TOTAL_MISMATCH', `The invoice total differs from the order total by ${totals.expectedTotalDifference} minor units`, 'totals');
  }
  if (totals.duePayable < 0) {
    add('OVERPAID', 'The prepaid amount is higher than the invoice total', 'payment.prepaidAmount');
  }
  if (totals.duePayable > 0 && isBlank(model.payment.terms) && isBlank(model.payment.dueDate)) {
    add('PAYMENT_TERMS_REQUIRED', 'An amount is due, so payment terms or a due date are required (BR-CO-25)', 'payment');
  }
  if (xrechnung && model.payment.means.length === 0) {
    add('PAYMENT_MEANS_MISSING', 'XRechnung requires payment instructions (BG-16, BR-DE-1)', 'payment.means');
  }
  model.payment.means.forEach((means, i) => {
    if (means.code === '58' && !('iban' in means && !isBlank(means.iban))) {
      add('PAYMENT_ACCOUNT_MISSING', 'SEPA credit transfer (58) requires the seller IBAN', `payment.means[${i}]`);
    }
  });

  return issues;
}

/** Seller data required by EN 16931 and XRechnung (BG-4, BG-6, BT-31/BT-32, BT-34). */
export function checkSeller(seller: Seller): InvoiceIssue[] {
  const issues: InvoiceIssue[] = [];
  const missing = [
    isBlank(seller.name) && 'name',
    isBlank(seller.address.line1) && 'street',
    isBlank(seller.address.postalCode) && 'postal code',
    isBlank(seller.address.city) && 'city',
    isBlank(seller.address.countryCode) && 'country',
    isBlank(seller.contact.name) && 'contact name',
    isBlank(seller.contact.phone) && 'contact phone',
    isBlank(seller.contact.email) && 'contact email',
    isBlank(seller.electronicAddress?.value) && 'electronic address (e.g. invoice email)',
  ].filter(Boolean);
  if (missing.length) {
    issues.push({ code: 'SELLER_INCOMPLETE', message: `Seller data is incomplete: ${missing.join(', ')}`, path: 'seller' });
  }
  if (isBlank(seller.vatId) && isBlank(seller.taxNumber)) {
    issues.push({ code: 'SELLER_TAX_ID_MISSING', message: 'The seller needs a VAT ID or a tax number', path: 'seller.vatId' });
  }
  return issues;
}

function checkLine(line: InvoiceLine, index: number, add: (code: IssueCode, message: string, path?: string) => void) {
  const path = `lines[${index}]`;
  if (line.netUnitPrice < 0) {
    add('NEGATIVE_AMOUNT', `Line ${line.id} has a negative price`, path);
  }
  const expected =
    multiply(line.netUnitPrice, line.quantity) - sum(line.allowances.map((a) => a.amount)) + sum(line.charges.map((c) => c.amount));
  if (expected !== line.netAmount) {
    add(
      'LINE_AMOUNT_MISMATCH',
      `Line ${line.id}: net amount ${line.netAmount} ≠ quantity × price − allowances + charges (${expected})`,
      path,
    );
  }
}
