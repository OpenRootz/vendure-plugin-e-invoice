import { AllowanceCharge, InvoiceLine, PaymentMeans, EInvoiceModel } from '../../model';
import { fill, Formatters, PdfLabels } from '../i18n';
import { LineColumn, toPt } from '../layout';

import { BlockRenderer, formatIban, LIGHT, PdfNode, textProp, withTax } from './context';

/** Default column widths of the line table in pt; the description takes the rest. */
const COLUMN_WIDTHS: Record<LineColumn, number> = { position: 22, quantity: 46, unitPrice: 62, vatRate: 34, amount: 66 };

export const introText: BlockRenderer = ({ block }) => {
  const text = textProp(block);
  return text ? { text } : null;
};

export const closingText = introText;

/** Free text with the placeholders `{number}`, `{issueDate}`, `{orderCode}` and `{buyerName}` (no amounts). */
export const customText: BlockRenderer = ({ block, model, f }) => {
  const text = textProp(block);
  if (!text) return null;
  return {
    text: fill(text, {
      number: model.number,
      issueDate: f.date(model.issueDate),
      orderCode: model.meta.orderCode,
      buyerName: model.buyer.name,
    }),
  };
};

/** The line table; the header row repeats on following pages. */
export const lines: BlockRenderer = ({ model, labels, f, accent, block }) => {
  const gross = model.meta.priceDisplay === 'gross';
  const kind = gross ? labels.gross : labels.net;
  const columns = (block.props?.columns ?? {}) as { position?: boolean; widths?: Partial<Record<LineColumn, number>> };
  const showPosition = columns.position !== false;
  const width = (c: LineColumn) => (columns.widths?.[c] !== undefined ? toPt(columns.widths[c]!) : COLUMN_WIDTHS[c]);
  const headers = [
    labels.position,
    labels.description,
    labels.quantity,
    `${labels.unitPrice} ${kind}`,
    labels.vatRate,
    `${labels.amount} ${kind}`,
  ];
  const header = headers.map((text, i) => ({ text, bold: true, fontSize: 8, alignment: i >= 2 ? 'right' : 'left', color: accent }));
  const rows = model.lines.map((line) => lineRow(line, gross, labels, f));
  const docRows = [...model.charges.map((c) => docRow(c, false, gross, f)), ...model.allowances.map((a) => docRow(a, true, gross, f))];
  const drop = <T>(row: T[]) => (showPosition ? row : row.slice(1));
  const widths = [width('position'), '*', width('quantity'), width('unitPrice'), width('vatRate'), width('amount')];
  return {
    table: { headerRows: 1, widths: drop(widths), body: [header, ...rows, ...docRows].map(drop) },
    layout: {
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === 1 || i === node.table.body.length ? 0.8 : 0.3),
      vLineWidth: () => 0,
      hLineColor: (i: number) => (i === 1 ? accent : LIGHT),
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
  };
};

function lineRow(line: InvoiceLine, gross: boolean, labels: PdfLabels, f: Formatters): PdfNode[] {
  const unitPrice = gross ? (line.display?.grossUnitPrice ?? withTax(line.netUnitPrice, line.vat.rate, undefined)) : line.netUnitPrice;
  const amount = gross ? (line.display?.grossAmount ?? withTax(line.netAmount, line.vat.rate, line.vendureTaxAmount)) : line.netAmount;
  const details: string[] = [];
  if (line.sellerItemId) details.push(`${labels.itemNumber} ${line.sellerItemId}`);
  if (line.description) details.push(line.description);
  for (const a of line.allowances.filter((x) => !(gross && x.rounding))) {
    details.push(gross ? a.reason : `− ${f.money(a.amount)} ${a.reason}`);
  }
  for (const c of line.charges.filter((x) => !(gross && x.rounding))) {
    details.push(gross ? c.reason : `+ ${f.money(c.amount)} ${c.reason}`);
  }
  return [
    line.id,
    { stack: [{ text: line.name }, ...details.map((d) => ({ text: d, fontSize: 7.5, color: '#555555' }))] },
    { text: `${f.decimal(line.quantity)} ${f.unit(line.unitCode)}`, alignment: 'right' },
    { text: f.money(unitPrice), alignment: 'right' },
    { text: f.percent(line.vat.rate), alignment: 'right' },
    { text: f.money(amount), alignment: 'right' },
  ];
}

function docRow(ac: AllowanceCharge, isAllowance: boolean, gross: boolean, f: Formatters): PdfNode[] {
  const rate = ac.vat?.rate ?? '0';
  const amount = gross ? withTax(ac.amount, rate, ac.vendureTaxAmount) : ac.amount;
  const signed = isAllowance ? `− ${f.money(amount)}` : f.money(amount);
  return ['', ac.reason, '', '', { text: f.percent(rate), alignment: 'right' }, { text: signed, alignment: 'right' }];
}

/** Net total, VAT breakdown and total. Always the XML values. */
export const totals: BlockRenderer = ({ model, labels, f, accent }) => {
  const t = model.totals;
  if (!t) throw new Error(`Invoice ${model.number}: totals have not been calculated`);
  const row = (label: string, value: string, bold = false) => [
    { text: label, bold },
    { text: value, alignment: 'right', bold },
  ];
  // Credit notes: the credited amount is booked as prepaid (nothing due); show it as the refund amount instead
  const isCredit = model.type === 'credit_note';
  const showDue = !isCredit && (t.prepaidAmount !== 0 || t.roundingAmount !== 0);
  const body = [
    row(labels.totalNet, f.money(t.taxBasisTotal)),
    ...t.vat.map((v) => row(`${labels.vat} ${f.percent(v.category.rate)} ${labels.vatOn} ${f.money(v.basisAmount)}`, f.money(v.taxAmount))),
    row(isCredit ? labels.refundTotal : labels.total, f.money(t.grandTotal), !showDue),
    t.roundingAmount !== 0 ? row(labels.rounding, f.money(t.roundingAmount)) : undefined,
    t.prepaidAmount !== 0 && !isCredit ? row(labels.prepaid, `− ${f.money(t.prepaidAmount)}`) : undefined,
    showDue ? row(labels.amountDue, f.money(t.duePayable), true) : undefined,
  ].filter(Boolean);
  return {
    table: { widths: ['*', 'auto'], body },
    layout: {
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === node.table.body.length - 1 ? 0.8 : 0),
      vLineWidth: () => 0,
      hLineColor: () => accent,
    },
  };
};

/** Exemption reasons of the non-standard VAT categories (§14 Abs. 4 Nr. 8 UStG). */
export function exemptionTexts(model: EInvoiceModel): string[] {
  return [
    ...new Set(
      (model.totals?.vat ?? [])
        .filter((v) => v.category.code !== 'S')
        .map((v) => v.category.exemptionReason ?? v.category.exemptionReasonCode)
        .filter((n): n is string => !!n),
    ),
  ];
}

export const exemptionNotes: BlockRenderer = ({ model }) => {
  const notes = exemptionTexts(model);
  return notes.length ? { stack: notes.map((n) => ({ text: n, bold: true })) } : null;
};

export const notes: BlockRenderer = ({ model }) =>
  model.notes.length ? { stack: model.notes.map((n, i) => ({ text: n, margin: [0, i ? 8 : 0, 0, 0] })) } : null;

export const payment: BlockRenderer = ({ model, labels, f }) => {
  const due = model.totals?.duePayable ?? 0;
  const lines: PdfNode[] = [];
  if (model.type === 'credit_note') {
    lines.push(model.meta.settlement === 'offset' ? labels.offset : labels.refunded);
  } else if (due > 0) {
    if (model.payment.terms) lines.push(model.payment.terms);
    if (model.payment.dueDate) lines.push(fill(labels.dueDate, { date: f.date(model.payment.dueDate) }));
    for (const means of model.payment.means) lines.push(...meansText(means, model, labels));
  } else if (model.type === 'invoice' && model.totals && model.totals.prepaidAmount > 0) {
    lines.push(labels.alreadyPaid);
    const methods = [...new Set(model.payment.means.map((m) => m.text).filter((t): t is string => !!t))];
    if (methods.length) lines.push(fill(labels.paidWith, { method: methods.join(', ') }));
  }
  return lines.length ? { unbreakable: true, stack: [{ text: labels.payment, bold: true, margin: [0, 0, 0, 2] }, ...lines] } : null;
};

function meansText(means: PaymentMeans, model: EInvoiceModel, labels: PdfLabels): PdfNode[] {
  if (means.code === '58' && 'iban' in means && means.iban) {
    const account = [`IBAN ${formatIban(means.iban)}`, means.bic ? `BIC ${means.bic}` : '', means.accountName ?? model.seller.name].filter(
      Boolean,
    );
    return [
      labels.transferTo,
      { text: account.join(' · '), bold: true },
      model.payment.reference ? `${labels.reference}: ${model.payment.reference}` : '',
    ].filter((n) => n !== '');
  }
  if (means.code === '59' && 'mandateReference' in means) {
    return [fill(labels.directDebit, { mandate: means.mandateReference, creditor: means.creditorId })];
  }
  return [];
}
