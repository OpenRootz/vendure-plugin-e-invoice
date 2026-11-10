import { calculate, vatGroupKey } from './calculate';
import { AllowanceCharge, CreditReference, Decimal, EInvoiceModel, InvoiceLine, IsoDate, Money, PaymentMeans, VatCategory } from './model';
import { addDecimal, compareDecimal, multiply, netFromGross, parseDecimal, percentOf, scaleMoney, subtractDecimal, sum } from './money';

/**
 * Credit notes (type 381) are always built from the snapshot of the corrected invoice, never from the order,
 * so they reverse exactly what was invoiced. Every item of a credit note references the invoice item it
 * reverses (`creditOf`); that is how the remaining, still creditable part of an invoice is derived from its
 * credit notes, and why the cumulative credited quantities and amounts can never exceed the invoice.
 */

export interface CreditNoteRequest {
  /** Credit these quantities of invoice lines (by BT-126 line ID). */
  lines?: { lineId: string; quantity: Decimal }[];
  /** Credit all document-level charges and allowances (shipping, surcharges) that have not been credited yet. */
  charges?: boolean;
  /**
   * Gross amount to credit in addition, split across the VAT rates of the remaining invoice amount
   * (e.g. a goodwill refund). A negative amount is a deduction from the items credited by this note
   * (e.g. a restocking fee).
   */
  amount?: Money;
  /** Credit everything that has not been credited yet (cancellation, modification). Other fields are ignored. */
  full?: boolean;
  /** Free text, written as a note (BT-22). */
  note?: string;
}

export interface CreditNoteTexts {
  /** Name of an amount-credit line, e.g. "Gutschrift 19 %" */
  amountLine: (category: VatCategory) => string;
  /** Reason of a deduction allowance (negative amount) */
  deduction: string;
  /** Reason of the allowance that offsets earlier amount credits in a full reversal */
  alreadyCredited: string;
  /** Reason of the price adjustment of a partially credited line */
  discount: string;
  /** Text of the payment means when the invoice was paid by credit transfer or direct debit */
  refund: string;
}

/** Gross amount of one VAT group, with its net and tax parts. */
export interface VatShare {
  category: VatCategory;
  net: Money;
  tax: Money;
}

export interface CreditAllocationInput {
  /** Gross amount to allocate (always positive) */
  amount: Money;
  /** The VAT groups it can be allocated to, with their available gross amount (net + tax) */
  shares: { category: VatCategory; gross: Money }[];
}

/** Returns the gross amount per share, in the order of `shares`. Must add up to `amount`. */
export type CreditAllocation = (input: CreditAllocationInput) => Money[];

export interface BuildCreditNoteOptions {
  issueDate: IsoDate;
  texts: CreditNoteTexts;
  /** How amount credits are split across VAT rates. Default: {@link allocateProportionally}. */
  allocate?: CreditAllocation;
  /** Payment means of the credit note. Default: derived from the invoice. */
  paymentMeans?: PaymentMeans[];
  /** See {@link CalculateOptions.fallbackThreshold} */
  fallbackThreshold?: Money;
  /** Refunded to the buyer (default) or offset against a new invoice. Only changes the PDF text. */
  settlement?: 'refund' | 'offset';
}

export type CreditNoteErrorCode =
  | 'NOT_AN_INVOICE'
  | 'INVOICE_FULLY_CREDITED'
  | 'UNKNOWN_LINE'
  | 'INVALID_QUANTITY'
  | 'QUANTITY_EXCEEDED'
  | 'AMOUNT_EXCEEDED'
  | 'NOTHING_TO_CREDIT';

export class CreditNoteError extends Error {
  constructor(
    public readonly code: CreditNoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CreditNoteError';
  }
}

/** What of an invoice has not been credited yet. */
export interface CreditableState {
  /** Remaining quantity and amounts per invoice line ID */
  lines: Map<string, { quantity: Decimal; net: Money; tax: Money }>;
  /** Indices of document-level charges / allowances that have not been credited */
  charges: Set<number>;
  allowances: Set<number>;
  /** Signed sum of the amount credits so far, per VAT group */
  amountCredits: Map<string, VatShare>;
  /** Remaining gross amount per VAT group */
  remaining: Map<string, VatShare>;
  /** Remaining gross amount of the invoice */
  remainingTotal: Money;
}

const itemTax = (net: Money, vendureTax: Money | undefined, category: VatCategory) => vendureTax ?? percentOf(net, category.rate);

function addShare(map: Map<string, VatShare>, category: VatCategory, net: Money, tax: Money) {
  const key = vatGroupKey(category);
  const share = map.get(key) ?? { category, net: 0, tax: 0 };
  share.net += net;
  share.tax += tax;
  map.set(key, share);
}

interface Contribution {
  category: VatCategory;
  /** Signed: allowances are negative */
  net: Money;
  tax: Money;
  ref?: CreditReference;
  quantity?: Decimal;
}

/** Signed net/tax contributions of all items of a model (allowances negative). */
function contributions(model: EInvoiceModel): Contribution[] {
  const items: Contribution[] = [];
  for (const line of model.lines) {
    const tax = itemTax(line.netAmount, line.vendureTaxAmount, line.vat);
    items.push({ category: line.vat, net: line.netAmount, tax, ref: line.creditOf, quantity: line.quantity });
  }
  for (const charge of model.charges) {
    if (!charge.vat) throw new Error(`Charge "${charge.reason}" has no VAT category`);
    const tax = itemTax(charge.amount, charge.vendureTaxAmount, charge.vat);
    items.push({ category: charge.vat, net: charge.amount, tax, ref: charge.creditOf });
  }
  for (const allowance of model.allowances) {
    if (!allowance.vat) throw new Error(`Allowance "${allowance.reason}" has no VAT category`);
    const tax = itemTax(allowance.amount, allowance.vendureTaxAmount, allowance.vat);
    items.push({ category: allowance.vat, net: -allowance.amount, tax: -tax, ref: allowance.creditOf });
  }
  return items;
}

const grossOf = (s: VatShare) => s.net + s.tax;

/** Derives what of `invoice` is still creditable, given its earlier credit notes. */
export function creditableState(invoice: EInvoiceModel, creditNotes: EInvoiceModel[]): CreditableState {
  const lines = new Map(
    invoice.lines.map((l) => [l.id, { quantity: l.quantity, net: l.netAmount, tax: itemTax(l.netAmount, l.vendureTaxAmount, l.vat) }]),
  );
  const charges = new Set(invoice.charges.map((_, i) => i));
  const allowances = new Set(invoice.allowances.map((_, i) => i));
  const amountCredits = new Map<string, VatShare>();
  const remaining = new Map<string, VatShare>();
  for (const item of contributions(invoice)) addShare(remaining, item.category, item.net, item.tax);

  for (const note of creditNotes) {
    for (const item of contributions(note)) {
      addShare(remaining, item.category, -item.net, -item.tax);
      const ref = item.ref;
      if (ref && 'line' in ref) {
        const line = lines.get(ref.line);
        if (!line) throw new Error(`Credit note ${note.number} references unknown line ${ref.line}`);
        line.quantity = subtractDecimal(line.quantity, item.quantity ?? '0');
        line.net -= item.net;
        line.tax -= item.tax;
      } else if (ref && 'charge' in ref) {
        charges.delete(ref.charge);
      } else if (ref && 'allowance' in ref) {
        allowances.delete(ref.allowance);
      } else {
        addShare(amountCredits, item.category, item.net, item.tax);
      }
    }
  }
  return { lines, charges, allowances, amountCredits, remaining, remainingTotal: sum([...remaining.values()].map(grossOf)) };
}

/**
 * Splits `amount` proportionally to the shares; the remainder from rounding goes to the largest share.
 * This is the default for amount-only refunds (EN 16931 needs the credited amount per VAT rate).
 */
export function allocateProportionally({ amount, shares }: CreditAllocationInput): Money[] {
  const total = sum(shares.map((s) => s.gross));
  if (total <= 0) return shares.map(() => 0);
  const result = shares.map((s) => scaleMoney(amount, String(s.gross), String(total)));
  const diff = amount - sum(result);
  if (diff !== 0) {
    let largest = 0;
    shares.forEach((s, i) => {
      if (s.gross > shares[largest].gross) largest = i;
    });
    result[largest] += diff;
  }
  return result;
}

/**
 * Builds a credit note for `invoice`, taking prices, VAT categories and parties from its snapshot.
 * Returns a model without number, with totals calculated; the credited amount is booked as prepaid, so nothing is due.
 * Throws {@link CreditNoteError} if the request cannot be fulfilled.
 */
export function buildCreditNote(
  invoice: EInvoiceModel,
  creditNotes: EInvoiceModel[],
  request: CreditNoteRequest,
  options: BuildCreditNoteOptions,
): EInvoiceModel {
  if (invoice.type !== 'invoice') throw new CreditNoteError('NOT_AN_INVOICE', `${invoice.number} is not an invoice`);
  const state = creditableState(invoice, creditNotes);
  if (state.remainingTotal <= 0) {
    throw new CreditNoteError('INVOICE_FULLY_CREDITED', `Invoice ${invoice.number} has already been credited in full`);
  }
  const { texts } = options;
  const lines: InvoiceLine[] = [];
  const charges: AllowanceCharge[] = [];
  const allowances: AllowanceCharge[] = [];

  const creditLine = (line: InvoiceLine, quantity: Decimal) => {
    const remaining = state.lines.get(line.id)!;
    const credited = subtractDecimal(line.quantity, remaining.quantity);
    const all = compareDecimal(quantity, remaining.quantity) === 0;
    // Shares are derived from the cumulative quantity, so rounding never drifts and the last credit is exact
    const share = (amount: Money, done: Money) =>
      all ? done : scaleMoney(amount, addDecimal(credited, quantity), line.quantity) - scaleMoney(amount, credited, line.quantity);
    const lineTax = itemTax(line.netAmount, line.vendureTaxAmount, line.vat);
    const net = share(line.netAmount, remaining.net);
    const tax = share(lineTax, remaining.tax);
    const diff = multiply(line.netUnitPrice, quantity) - net;
    const adjust = (source: AllowanceCharge[], amount: Money): AllowanceCharge[] => {
      if (amount === 0) return [];
      const reason = [...new Set(source.map((a) => a.reason))].join(', ') || texts.discount;
      const rounding = source.length > 0 && source.every((a) => a.rounding);
      return [{ amount, reason, ...(rounding ? { rounding } : {}) }];
    };
    lines.push({
      ...line,
      id: '',
      quantity,
      allowances: diff > 0 ? adjust(line.allowances, diff) : [],
      charges: diff < 0 ? adjust(line.charges, -diff) : [],
      netAmount: net,
      vendureTaxAmount: tax,
      display: line.display ? { grossUnitPrice: line.display.grossUnitPrice, grossAmount: net + tax } : undefined,
      creditOf: { line: line.id },
    });
  };
  const creditCharges = () => {
    invoice.charges.forEach((c, i) => state.charges.has(i) && charges.push({ ...c, creditOf: { charge: i } }));
    invoice.allowances.forEach((a, i) => state.allowances.has(i) && allowances.push({ ...a, creditOf: { allowance: i } }));
  };

  if (request.full) {
    for (const line of invoice.lines) {
      const remaining = state.lines.get(line.id)!;
      if (compareDecimal(remaining.quantity, '0') > 0) creditLine(line, remaining.quantity);
    }
    creditCharges();
    // Earlier amount credits are offset, so the credit notes add up to the invoice exactly
    for (const share of state.amountCredits.values()) {
      const gross = grossOf(share);
      const item = { reason: texts.alreadyCredited, vat: share.category };
      if (gross > 0) allowances.push({ ...item, amount: share.net, vendureTaxAmount: share.tax });
      else if (gross < 0) charges.push({ ...item, amount: -share.net, vendureTaxAmount: -share.tax });
    }
  } else {
    const quantities = new Map<string, Decimal>();
    for (const { lineId, quantity } of request.lines ?? []) {
      if (!/^\d+(\.\d+)?$/.test(String(quantity)) || parseDecimal(quantity).value === 0n) {
        throw new CreditNoteError('INVALID_QUANTITY', `Invalid quantity "${quantity}" for line ${lineId}`);
      }
      quantities.set(lineId, addDecimal(quantities.get(lineId) ?? '0', quantity));
    }
    for (const [lineId, quantity] of quantities) {
      const line = invoice.lines.find((l) => l.id === lineId);
      if (!line) throw new CreditNoteError('UNKNOWN_LINE', `Invoice ${invoice.number} has no line ${lineId}`);
      const remaining = state.lines.get(lineId)!.quantity;
      if (compareDecimal(quantity, remaining) > 0) {
        throw new CreditNoteError(
          'QUANTITY_EXCEEDED',
          `Line ${lineId} ("${line.name}"): ${quantity} requested, ${remaining} left to credit`,
        );
      }
      creditLine(line, quantity);
    }
    if (request.charges) creditCharges();

    const amount = request.amount ?? 0;
    if (amount !== 0) {
      const thisNote = new Map<string, VatShare>();
      const draft = { ...invoice, lines, charges, allowances } as EInvoiceModel;
      for (const item of contributions(draft)) addShare(thisNote, item.category, item.net, item.tax);
      // A credit goes to what is left of the invoice; a deduction reduces what this note credits
      const inThisNote = (key: string) => {
        const share = thisNote.get(key);
        return share ? grossOf(share) : 0;
      };
      const available =
        amount > 0
          ? [...state.remaining.entries()].map(([key, s]) => ({ category: s.category, gross: grossOf(s) - inThisNote(key) }))
          : [...thisNote.values()].map((s) => ({ category: s.category, gross: grossOf(s) }));
      const shares = available.filter((s) => s.gross > 0);
      const abs = Math.abs(amount);
      if (abs > sum(shares.map((s) => s.gross))) {
        throw new CreditNoteError(
          'AMOUNT_EXCEEDED',
          amount > 0
            ? `The amount exceeds what is left to credit of invoice ${invoice.number}`
            : 'The deduction exceeds the amount credited by this credit note',
        );
      }
      const allocated = (options.allocate ?? allocateProportionally)({ amount: abs, shares });
      if (allocated.length !== shares.length || sum(allocated) !== abs || allocated.some((a) => !Number.isSafeInteger(a) || a < 0)) {
        throw new Error('Credit allocation must return one non-negative amount per share, adding up to the amount');
      }
      shares.forEach(({ category }, i) => {
        const gross = allocated[i];
        if (gross === 0) return;
        const net = netFromGross(gross, category.rate);
        if (amount > 0) {
          lines.push({
            id: '',
            name: texts.amountLine(category),
            quantity: '1',
            unitCode: 'C62',
            netUnitPrice: net,
            allowances: [],
            charges: [],
            netAmount: net,
            vat: category,
            vendureTaxAmount: gross - net,
            display: { grossUnitPrice: gross, grossAmount: gross },
          });
        } else {
          allowances.push({ amount: net, reason: texts.deduction, vat: category, vendureTaxAmount: gross - net });
        }
      });
    }
  }

  // EN 16931 requires at least one line (BR-16): a credit note of charges only (e.g. shipping) lists them as lines
  if (lines.length === 0) {
    for (const charge of charges.splice(0)) {
      lines.push({
        id: '',
        name: charge.reason,
        quantity: '1',
        unitCode: 'C62',
        netUnitPrice: charge.amount,
        allowances: [],
        charges: [],
        netAmount: charge.amount,
        vat: charge.vat as VatCategory,
        vendureTaxAmount: charge.vendureTaxAmount,
        creditOf: charge.creditOf,
      });
    }
  }
  if (lines.length === 0) throw new CreditNoteError('NOTHING_TO_CREDIT', 'The credit note has no items');
  lines.forEach((l, i) => (l.id = String(i + 1)));

  const model: EInvoiceModel = {
    ...invoice,
    type: 'credit_note',
    number: '',
    issueDate: options.issueDate,
    precedingInvoices: [{ number: invoice.number, issueDate: invoice.issueDate }],
    notes: request.note?.trim() ? [request.note.trim()] : [],
    lines,
    allowances,
    charges,
    payment: { means: options.paymentMeans ?? creditPaymentMeans(invoice.payment.means, texts), prepaidAmount: 0 },
    taxCalculation: invoice.totals?.taxCalculation ?? invoice.taxCalculation,
    totals: undefined,
    meta: { ...invoice.meta, settlement: options.settlement ?? 'refund' },
  };

  // Guard: per VAT group, never credit more than is left
  const credited = new Map<string, VatShare>();
  for (const item of contributions(model)) addShare(credited, item.category, item.net, item.tax);
  for (const [key, share] of credited) {
    const left = state.remaining.get(key);
    if (grossOf(share) > (left ? grossOf(left) : 0)) {
      throw new CreditNoteError(
        'AMOUNT_EXCEEDED',
        `The credit note exceeds what is left to credit of invoice ${invoice.number} for VAT ${share.category.code} ${share.category.rate} %`,
      );
    }
  }
  const expected = sum([...credited.values()].map(grossOf));
  if (expected <= 0) throw new CreditNoteError('NOTHING_TO_CREDIT', 'The credit note total must be positive');

  const calc = { expectedTotalWithTax: expected, fallbackThreshold: options.fallbackThreshold };
  const first = calculate(model, calc);
  model.payment.prepaidAmount = first.grandTotal + first.roundingAmount;
  model.totals = calculate(model, calc);
  return model;
}

/**
 * The refund goes back the way the customer paid. A SEPA credit transfer (58) or direct debit (59) of the invoice
 * describes the seller's account or mandate, which does not apply to a refund, so those become "mutually defined".
 */
export function creditPaymentMeans(means: PaymentMeans[], texts: Pick<CreditNoteTexts, 'refund'>): PaymentMeans[] {
  const result: PaymentMeans[] = [];
  for (const m of means) {
    const mapped: PaymentMeans = m.code === '58' || m.code === '59' ? { code: 'ZZZ', text: texts.refund } : m;
    if (!result.some((r) => r.code === mapped.code && r.text === mapped.text)) result.push(mapped);
  }
  return result;
}

export interface CreditableSummary {
  lines: {
    lineId: string;
    orderLineId?: string;
    name: string;
    sellerItemId?: string;
    invoicedQuantity: Decimal;
    remainingQuantity: Decimal;
    /** Gross amount of the remaining quantity */
    remainingGross: Money;
  }[];
  /** Gross amount of the document-level charges (shipping, surcharges) minus allowances not credited yet */
  chargesGross: Money;
  /** Remaining gross amount of the invoice */
  remainingTotal: Money;
}

/** What can still be credited, per line, for display (e.g. the credit note dialog). */
export function creditableSummary(invoice: EInvoiceModel, creditNotes: EInvoiceModel[]): CreditableSummary {
  const state = creditableState(invoice, creditNotes);
  const gross = (net: Money, vendureTax: Money | undefined, vat: VatCategory | undefined) =>
    vat ? net + itemTax(net, vendureTax, vat) : net;
  return {
    lines: invoice.lines.map((line) => {
      const rest = state.lines.get(line.id);
      return {
        lineId: line.id,
        orderLineId: line.orderLineId,
        name: line.name,
        sellerItemId: line.sellerItemId,
        invoicedQuantity: line.quantity,
        remainingQuantity: rest?.quantity ?? '0',
        remainingGross: rest ? rest.net + rest.tax : 0,
      };
    }),
    chargesGross:
      sum([...state.charges].map((i) => gross(invoice.charges[i].amount, invoice.charges[i].vendureTaxAmount, invoice.charges[i].vat))) -
      sum(
        [...state.allowances].map((i) =>
          gross(invoice.allowances[i].amount, invoice.allowances[i].vendureTaxAmount, invoice.allowances[i].vat),
        ),
      ),
    remainingTotal: state.remainingTotal,
  };
}
