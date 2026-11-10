/** The hand-written template before the layout engine (0.1.0), kept as the reference of the default layout. */
import { AllowanceCharge, Address, EInvoiceModel, InvoiceLine, Money, PaymentMeans } from '../../src/core/model';
import { percentOf } from '../../src/core/money';

import { fill, Formatters, formatters, PdfLabels } from '../../src/core/pdf/i18n';
import { PdfDocDefinition } from '../../src/core/pdf/printer';

export interface PdfLayout {
  /** Hex color for the title, table header and lines, e.g. `#1a5fb4` */
  accentColor?: string;
  /** Text above the line table */
  introText?: string;
  /** Text below the payment information */
  closingText?: string;
  /** Additional footer line */
  footerText?: string;
}

export interface PdfTemplateInput {
  model: EInvoiceModel;
  labels: PdfLabels;
  layout?: PdfLayout;
  /** Logo as a PNG/JPEG data URL or as SVG markup */
  logo?: { dataUrl: string } | { svg: string };
}

type Node = Record<string, unknown> | string;

const GREY = '#555555';
const LIGHT = '#dddddd';

/**
 * The default invoice layout (DIN 5008-like A4): sender line and address window, invoice details,
 * line table, totals with the VAT breakdown, payment information and a footer with the legal details.
 *
 * Amounts in the totals block are always the XML values. Line prices are shown net or gross
 * depending on `model.meta.priceDisplay`.
 */
export function legacyTemplate(input: PdfTemplateInput): PdfDocDefinition {
  const { model, labels } = input;
  const layout = input.layout ?? {};
  const accent = /^#[0-9a-f]{6}$/i.test(layout.accentColor ?? '') ? (layout.accentColor as string) : '#333333';
  const f = formatters(labels, model.currencyCode, model.amountDecimals);
  const isCredit = model.type === 'credit_note';

  const content: Node[] = [
    header(input, f),
    {
      text: `${isCredit ? labels.creditNote : labels.invoice} ${model.number}`,
      style: 'title',
      color: accent,
      margin: [0, 24, 0, 4],
    },
    ...model.precedingInvoices.map((p) => ({
      text: fill(labels.correctsInvoice, { number: p.number, date: f.date(p.issueDate) }),
      margin: [0, 0, 0, 4],
    })),
    layout.introText ? { text: layout.introText, margin: [0, 8, 0, 0] } : '',
    lineTable(model, labels, f, accent),
    totals(model, labels, f, accent),
    exemptionNotes(model),
    ...model.notes.map((n) => ({ text: n, margin: [0, 8, 0, 0] })),
    payment(model, labels, f),
    layout.closingText ? { text: layout.closingText, margin: [0, 12, 0, 0] } : '',
  ].filter((n) => n !== '');

  return {
    pageSize: 'A4',
    pageMargins: [56, 48, 56, 96],
    defaultStyle: { fontSize: 9, lineHeight: 1.15 },
    styles: {
      title: { fontSize: 16, bold: true },
      small: { fontSize: 7, color: GREY },
      tableHeader: { bold: true, fontSize: 8 },
      detail: { fontSize: 7.5, color: GREY },
    },
    content,
    footer: (currentPage: number, pageCount: number) => footer(model, labels, layout, currentPage, pageCount),
  };
}

function header(input: PdfTemplateInput, f: Formatters): Node {
  const { model, labels } = input;
  const { seller, buyer } = model;
  const sender = [seller.name, seller.address.line1, `${seller.address.postalCode} ${seller.address.city}`].join(' · ');
  const isCredit = model.type === 'credit_note';

  const details: [string, string | undefined][] = [
    [isCredit ? labels.creditNoteNumber : labels.invoiceNumber, model.number],
    [labels.invoiceDate, f.date(model.issueDate)],
    [labels.deliveryDate, model.deliveryDate ? f.date(model.deliveryDate) : undefined],
    [labels.orderNumber, model.salesOrderReference],
    [labels.purchaseOrder, model.orderReference],
    [labels.buyerReference, model.buyerReference !== model.salesOrderReference ? model.buyerReference : undefined],
    [labels.buyerVatId, buyer.vatId],
  ];

  const logo = input.logo
    ? 'dataUrl' in input.logo
      ? { image: input.logo.dataUrl, fit: [160, 60], alignment: 'right', margin: [0, 0, 0, 12] }
      : { svg: input.logo.svg, fit: [160, 60], alignment: 'right', margin: [0, 0, 0, 12] }
    : '';

  return {
    stack: [
      logo,
      {
        columns: [
          {
            width: '*',
            stack: [
              { text: sender, style: 'small', margin: [0, 0, 0, 6] },
              ...addressLines(buyer.name, buyer.address, buyer.contact?.name, model.seller.address.countryCode, labels),
            ],
          },
          {
            width: 210,
            table: {
              widths: ['auto', '*'],
              body: details
                .filter(([, v]) => v)
                .map(([k, v]) => [
                  { text: k, color: GREY },
                  { text: v, alignment: 'right' },
                ]),
            },
            layout: 'noBorders',
          },
        ],
        columnGap: 24,
      },
      model.delivery
        ? {
            margin: [0, 10, 0, 0],
            stack: [
              { text: labels.deliveryAddress, style: 'small' },
              {
                text: addressLines(
                  model.delivery.name ?? '',
                  model.delivery.address,
                  undefined,
                  model.seller.address.countryCode,
                  labels,
                ).join(', '),
              },
            ],
          }
        : '',
    ].filter((n) => n !== ''),
  };
}

function addressLines(name: string, address: Address, contact: string | undefined, homeCountry: string, labels: PdfLabels): string[] {
  const country = address.countryCode && address.countryCode !== homeCountry ? countryName(address.countryCode, labels.locale) : undefined;
  return [
    name,
    contact && contact !== name ? contact : '',
    address.line1,
    address.line2 ?? '',
    address.line3 ?? '',
    `${address.postalCode} ${address.city}`.trim(),
    country ?? '',
  ].filter((l) => l);
}

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Amount including VAT, for gross display: Vendure's tax where known, else computed from the rate. */
function withTax(amount: Money, rate: string, vendureTax: Money | undefined): Money {
  return amount + (vendureTax ?? percentOf(amount, rate));
}

function lineTable(model: EInvoiceModel, labels: PdfLabels, f: Formatters, accent: string): Node {
  const gross = model.meta.priceDisplay === 'gross';
  const kind = gross ? labels.gross : labels.net;
  const header = [
    labels.position,
    labels.description,
    labels.quantity,
    `${labels.unitPrice} ${kind}`,
    labels.vatRate,
    `${labels.amount} ${kind}`,
  ].map((text, i) => ({ text, style: 'tableHeader', alignment: i >= 2 ? 'right' : 'left', color: accent }));
  const rows = model.lines.map((line) => lineRow(line, gross, labels, f));
  const docRows = [...model.charges.map((c) => docRow(c, false, gross, f)), ...model.allowances.map((a) => docRow(a, true, gross, f))];
  return {
    margin: [0, 14, 0, 0],
    table: { headerRows: 1, widths: [22, '*', 46, 62, 34, 66], body: [header, ...rows, ...docRows] },
    layout: {
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === 1 || i === node.table.body.length ? 0.8 : 0.3),
      vLineWidth: () => 0,
      hLineColor: (i: number) => (i === 1 ? accent : LIGHT),
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
  };
}

function lineRow(line: InvoiceLine, gross: boolean, labels: PdfLabels, f: Formatters): Node[] {
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
    { stack: [{ text: line.name }, ...details.map((d) => ({ text: d, style: 'detail' }))] },
    { text: `${f.decimal(line.quantity)} ${f.unit(line.unitCode)}`, alignment: 'right' },
    { text: f.money(unitPrice), alignment: 'right' },
    { text: f.percent(line.vat.rate), alignment: 'right' },
    { text: f.money(amount), alignment: 'right' },
  ];
}

function docRow(ac: AllowanceCharge, isAllowance: boolean, gross: boolean, f: Formatters): Node[] {
  const rate = ac.vat?.rate ?? '0';
  const amount = gross ? withTax(ac.amount, rate, ac.vendureTaxAmount) : ac.amount;
  const signed = isAllowance ? `− ${f.money(amount)}` : f.money(amount);
  return ['', ac.reason, '', '', { text: f.percent(rate), alignment: 'right' }, { text: signed, alignment: 'right' }];
}

function totals(model: EInvoiceModel, labels: PdfLabels, f: Formatters, accent: string): Node {
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
    margin: [0, 10, 0, 0],
    columns: [
      { width: '*', text: '' },
      {
        width: 240,
        table: { widths: ['*', 'auto'], body },
        layout: {
          hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === node.table.body.length - 1 ? 0.8 : 0),
          vLineWidth: () => 0,
          hLineColor: () => accent,
        },
      },
    ],
  };
}

function exemptionNotes(model: EInvoiceModel): Node {
  const notes = [
    ...new Set(
      (model.totals?.vat ?? [])
        .filter((v) => v.category.code !== 'S')
        .map((v) => v.category.exemptionReason ?? v.category.exemptionReasonCode)
        .filter((n): n is string => !!n),
    ),
  ];
  return notes.length ? { margin: [0, 10, 0, 0], stack: notes.map((n) => ({ text: n, bold: true })) } : '';
}

function payment(model: EInvoiceModel, labels: PdfLabels, f: Formatters): Node {
  const due = model.totals?.duePayable ?? 0;
  const lines: Node[] = [];
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
  return lines.length
    ? { margin: [0, 16, 0, 0], unbreakable: true, stack: [{ text: labels.payment, bold: true, margin: [0, 0, 0, 2] }, ...lines] }
    : '';
}

function meansText(means: PaymentMeans, model: EInvoiceModel, labels: PdfLabels): Node[] {
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

function formatIban(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

function footer(model: EInvoiceModel, labels: PdfLabels, layout: PdfLayout, currentPage: number, pageCount: number): Node {
  const s = model.seller;
  const bank = model.payment.means.find((m): m is Extract<PaymentMeans, { code: '58' }> => m.code === '58' && 'iban' in m && !!m.iban);
  const col = (lines: (string | undefined)[]) => ({ width: '*', stack: lines.filter(Boolean).map((text) => ({ text })) });
  return {
    margin: [56, 16, 56, 0],
    style: 'small',
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 483, y2: 0, lineWidth: 0.3, lineColor: LIGHT }], margin: [0, 0, 0, 4] },
      {
        columns: [
          col([s.name, s.address.line1, `${s.address.postalCode} ${s.address.city}`]),
          col([s.contact.phone && `${labels.phone} ${s.contact.phone}`, s.contact.email && `${labels.email} ${s.contact.email}`]),
          col([
            s.vatId && `${labels.vatId} ${s.vatId}`,
            s.taxNumber && `${labels.taxNumber} ${s.taxNumber}`,
            s.legalRegistration?.id,
            s.legalInfo,
          ]),
          col([bank && `IBAN ${formatIban(bank.iban)}`, bank?.bic && `BIC ${bank.bic}`]),
        ],
        columnGap: 8,
      },
      layout.footerText ? { text: layout.footerText, margin: [0, 4, 0, 0] } : '',
      { text: `${labels.page} ${currentPage} ${labels.of} ${pageCount}`, alignment: 'right', margin: [0, 4, 0, 0] },
    ].filter((n) => n !== ''),
  };
}
