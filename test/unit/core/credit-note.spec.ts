import { describe, expect, it } from 'vitest';

import {
  allocateProportionally,
  buildCreditNote,
  calculate,
  checkModel,
  CreditNoteError,
  CreditNoteRequest,
  CreditNoteTexts,
  creditableState,
  EInvoiceModel,
} from '../../../src/core';
import { line, model, VAT_19, VAT_7 } from '../../fixtures/model-builders';

const texts: CreditNoteTexts = {
  amountLine: (c) => `Gutschrift ${c.rate} %`,
  deduction: 'Abzug',
  alreadyCredited: 'Bereits gutgeschrieben',
  discount: 'Rabatt',
  refund: 'Erstattung',
};

const ZERO = { code: 'Z' as const, rate: '0' };

/** Net channel invoice: 3 × 10.00 (19 %, 2.00 promotion), 1 × 18.69 (7 %), 1 × 189.00 (Z), shipping 4.90 */
function invoice(): EInvoiceModel {
  const m = model({
    lines: [
      line(1000, '3', VAT_19, {
        id: '1',
        name: 'Kaffee',
        netAmount: 2800,
        allowances: [{ amount: 200, reason: 'Herbstrabatt' }],
        vendureTaxAmount: 532,
      }),
      line(1869, '1', VAT_7, { id: '2', name: 'Buch', vendureTaxAmount: 131 }),
      line(18900, '1', ZERO, { id: '3', name: 'Solarmodul', vendureTaxAmount: 0 }),
    ],
    charges: [{ amount: 490, reason: 'DHL Paket', reasonCode: 'FC', vat: VAT_19, vendureTaxAmount: 93 }],
    payment: { means: [{ code: '58', iban: 'DE02120300000000202051' }], terms: '14 Tage', prepaidAmount: 0 },
  });
  m.totals = calculate(m);
  return m;
}

const gross = (m: EInvoiceModel) => (m.totals?.grandTotal ?? 0) + (m.totals?.roundingAmount ?? 0);

function credit(original: EInvoiceModel, previous: EInvoiceModel[], request: CreditNoteRequest) {
  const note = buildCreditNote(original, previous, request, { issueDate: '2026-11-20', texts });
  note.number = `GS-${previous.length + 1}`;
  return note;
}

function expectValid(note: EInvoiceModel) {
  expect(checkModel(note, ['zugferd', 'xrechnung-cii', 'xrechnung-ubl'])).toEqual([]);
  expect(note.totals?.duePayable).toBe(0);
}

describe('buildCreditNote', () => {
  it('reverses the whole invoice', () => {
    const original = invoice();
    const note = credit(original, [], { full: true });
    expectValid(note);
    expect(note).toMatchObject({
      type: 'credit_note',
      issueDate: '2026-11-20',
      precedingInvoices: [{ number: 'RE-2026-00001', issueDate: '2026-11-09' }],
    });
    expect(note.totals).toMatchObject({ taxBasisTotal: original.totals!.taxBasisTotal, taxTotal: original.totals!.taxTotal });
    expect(note.totals?.vat).toEqual(original.totals?.vat);
    expect(note.charges).toEqual([{ ...original.charges[0], creditOf: { charge: 0 } }]);
    expect(creditableState(original, [note]).remainingTotal).toBe(0);
  });

  it('refunds via "mutually defined" instead of the seller account', () => {
    const note = credit(invoice(), [], { full: true });
    expect(note.payment.means).toEqual([{ code: 'ZZZ', text: 'Erstattung' }]);
    expect(note.payment.terms).toBeUndefined();
  });

  it('credits partial quantities without rounding drift', () => {
    const original = invoice();
    const first = credit(original, [], { lines: [{ lineId: '1', quantity: '1' }] });
    const second = credit(original, [first], { lines: [{ lineId: '1', quantity: '1' }] });
    const third = credit(original, [first, second], { lines: [{ lineId: '1', quantity: '1' }] });
    for (const n of [first, second, third]) expectValid(n);
    // 2800 / 3 → 933, 934 (cumulative 1867), 933
    expect([first, second, third].map((n) => n.lines[0].netAmount)).toEqual([933, 934, 933]);
    expect([first, second, third].map((n) => n.lines[0].vendureTaxAmount)).toEqual([177, 178, 177]);
    expect(first.lines[0]).toMatchObject({
      quantity: '1',
      netUnitPrice: 1000,
      allowances: [{ amount: 67, reason: 'Herbstrabatt' }],
      creditOf: { line: '1' },
    });
    expect(creditableState(original, [first, second, third]).lines.get('1')).toEqual({ quantity: '0', net: 0, tax: 0 });
    expect(() => credit(original, [first, second, third], { lines: [{ lineId: '1', quantity: '1' }] })).toThrow(/0 left to credit/);
  });

  it('splits an amount across the VAT rates of the invoice (Q5)', () => {
    const original = invoice();
    const note = credit(original, [], { amount: 5000 });
    expectValid(note);
    expect(gross(note)).toBe(5000);
    // gross per rate: 19 % 3290+625, 7 % 2000, 0 % 18900 → total 24815
    expect(note.lines.map((l) => [l.name, l.netAmount + (l.vendureTaxAmount ?? 0)])).toEqual([
      ['Gutschrift 19 %', 789],
      ['Gutschrift 7 %', 403],
      ['Gutschrift 0 %', 3808],
    ]);
    expect(note.lines[0]).toMatchObject({ quantity: '1', unitCode: 'C62', netUnitPrice: 663, netAmount: 663, vendureTaxAmount: 126 });
  });

  it('gives the rounding remainder to the largest share', () => {
    const shares = [
      { category: VAT_19, gross: 100 },
      { category: VAT_7, gross: 100 },
      { category: ZERO, gross: 101 },
    ];
    expect(allocateProportionally({ amount: 100, shares })).toEqual([33, 33, 34]);
  });

  it('offsets earlier amount credits in a full reversal, so the credit notes add up to the invoice', () => {
    const original = invoice();
    const goodwill = credit(original, [], { amount: 5000 });
    const rest = credit(original, [goodwill], { full: true });
    expectValid(rest);
    expect(gross(goodwill) + gross(rest)).toBe(gross(original));
    expect(rest.allowances.map((a) => a.reason)).toEqual(['Bereits gutgeschrieben', 'Bereits gutgeschrieben', 'Bereits gutgeschrieben']);
    expect(() => credit(original, [goodwill, rest], { amount: 1 })).toThrow(CreditNoteError);
  });

  it('lists a shipping-only credit as a line (an invoice needs at least one line)', () => {
    const original = invoice();
    const note = credit(original, [], { charges: true });
    expectValid(note);
    expect(note.charges).toEqual([]);
    expect(note.lines).toEqual([
      expect.objectContaining({ name: 'DHL Paket', netAmount: 490, vendureTaxAmount: 93, creditOf: { charge: 0 } }),
    ]);
    expect(creditableState(original, [note]).charges.size).toBe(0);
    // charges are credited only once
    expect(() => credit(original, [note], { charges: true })).toThrow(/no items/);
  });

  it('deducts a negative amount from the credited items', () => {
    const note = credit(invoice(), [], { lines: [{ lineId: '2', quantity: '1' }], amount: -500 });
    expectValid(note);
    expect(gross(note)).toBe(2000 - 500);
    expect(note.allowances).toEqual([{ amount: 467, reason: 'Abzug', vat: VAT_7, vendureTaxAmount: 33 }]);
  });

  it('rejects what cannot be credited', () => {
    const original = invoice();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as CreditNoteError).code;
      }
      return undefined;
    };
    expect(code(() => credit(original, [], { lines: [{ lineId: '9', quantity: '1' }] }))).toBe('UNKNOWN_LINE');
    expect(code(() => credit(original, [], { lines: [{ lineId: '1', quantity: '4' }] }))).toBe('QUANTITY_EXCEEDED');
    expect(code(() => credit(original, [], { lines: [{ lineId: '1', quantity: '-1' }] }))).toBe('INVALID_QUANTITY');
    expect(code(() => credit(original, [], { amount: gross(original) + 1 }))).toBe('AMOUNT_EXCEEDED');
    expect(code(() => credit(original, [], { lines: [{ lineId: '2', quantity: '1' }], amount: -2001 }))).toBe('AMOUNT_EXCEEDED');
    expect(code(() => credit(original, [], {}))).toBe('NOTHING_TO_CREDIT');
    const full = credit(original, [], { full: true });
    expect(code(() => credit(original, [full], { full: true }))).toBe('INVOICE_FULLY_CREDITED');
    expect(code(() => credit(full, [], { full: true }))).toBe('NOT_AN_INVOICE');
  });

  it('does not credit a line after its VAT rate was credited by amount', () => {
    const original = invoice();
    // 2000 = everything at 7 % … plus a share of the other rates
    const goodwill = credit(original, [], { amount: gross(original) - 100 });
    expect(() => credit(original, [goodwill], { lines: [{ lineId: '2', quantity: '1' }] })).toThrow(/VAT S 7 %/);
  });

  it('keeps the applied tax calculation of the invoice and books BT-114 in en16931 mode', () => {
    const m = model({
      taxCalculation: 'en16931',
      lines: [
        line(335, '1', VAT_19, { vendureTaxAmount: 64 }),
        line(419, '1', VAT_19, { vendureTaxAmount: 80 }),
        line(503, '1', VAT_19, { vendureTaxAmount: 96 }),
      ],
      payment: { means: [{ code: '48', cardLast4: '1234' }], prepaidAmount: 1497 },
    });
    m.totals = calculate(m, { expectedTotalWithTax: 1497 });
    const note = credit(m, [], { full: true });
    expectValid(note);
    expect(note.taxCalculation).toBe('en16931');
    expect(gross(note)).toBe(1497);
    expect(note.totals?.roundingAmount).toBe(m.totals.roundingAmount);
    expect(note.payment.means).toEqual([{ code: '48', cardLast4: '1234' }]);
  });

  it('uses a custom allocation', () => {
    const note = buildCreditNote(
      invoice(),
      [],
      { amount: 1000 },
      {
        issueDate: '2026-11-20',
        texts,
        allocate: ({ shares }) => shares.map((s) => (s.category.rate === '7' ? 1000 : 0)),
      },
    );
    expect(note.lines.map((l) => l.vat.rate)).toEqual(['7']);
    expect(() => buildCreditNote(invoice(), [], { amount: 1000 }, { issueDate: '2026-11-20', texts, allocate: () => [1] })).toThrow(
      /allocation/,
    );
  });
});
