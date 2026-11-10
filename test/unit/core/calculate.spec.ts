import { describe, expect, it } from 'vitest';

import { calculate, EInvoiceModel } from '../../../src/core';
import { line, model, VAT_19, VAT_7 } from '../../fixtures/model-builders';

/** B2B net channel: line allowance, shipping as document charge (numbers validated with KoSIT and Mustang). */
function b2b(): EInvoiceModel {
  return model({
    lines: [
      line(1000, '2', VAT_19, {
        allowances: [{ amount: 200, reason: 'Promotion: 10 % Herbstrabatt' }],
        netAmount: 1800,
        vendureTaxAmount: 342,
      }),
      line(500, '1', VAT_19, { vendureTaxAmount: 95 }),
    ],
    charges: [{ amount: 490, reason: 'Versand DHL', reasonCode: 'FC', vat: VAT_19, vendureTaxAmount: 93 }],
  });
}

/** B2C gross channel: 3.99 + 4.99 + 5.99, Vendure line tax 2.40 vs. EN 16931 2.39. */
function rounding(taxCalculation: 'vendure' | 'en16931'): EInvoiceModel {
  return model({
    taxCalculation,
    lines: [
      line(335, '1', VAT_19, { vendureTaxAmount: 64 }),
      line(419, '1', VAT_19, { vendureTaxAmount: 80 }),
      line(503, '1', VAT_19, { vendureTaxAmount: 96 }),
    ],
    payment: { means: [{ code: '48', cardLast4: '1234' }], prepaidAmount: 1497 },
  });
}

describe('calculate', () => {
  it('computes the B2B reference totals', () => {
    const t = calculate(b2b(), { expectedTotalWithTax: 3320 });
    expect(t).toMatchObject({
      lineTotal: 2300,
      allowanceTotal: 0,
      chargeTotal: 490,
      taxBasisTotal: 2790,
      taxTotal: 530,
      grandTotal: 3320,
      roundingAmount: 0,
      duePayable: 3320,
      expectedTotalDifference: 0,
      taxCalculation: 'vendure',
    });
    expect(t.vat).toEqual([{ category: VAT_19, basisAmount: 2790, taxAmount: 530 }]);
  });

  it('vendure mode: uses the per-line tax, invoice total = paid total, no rounding amount', () => {
    const t = calculate(rounding('vendure'), { expectedTotalWithTax: 1497 });
    expect(t.vat[0]).toMatchObject({ basisAmount: 1257, taxAmount: 240 });
    expect(t).toMatchObject({ grandTotal: 1497, roundingAmount: 0, duePayable: 0, expectedTotalDifference: 0 });
    expect(t.warnings).toEqual([]);
  });

  it('en16931 mode: tax on the sum, difference goes into BT-114', () => {
    const t = calculate(rounding('en16931'), { expectedTotalWithTax: 1497 });
    expect(t.vat[0]).toMatchObject({ basisAmount: 1257, taxAmount: 239 });
    expect(t).toMatchObject({ grandTotal: 1496, roundingAmount: 1, duePayable: 0, expectedTotalDifference: 0 });
  });

  it('en16931 mode without an expected total has no rounding amount', () => {
    const t = calculate(rounding('en16931'));
    expect(t.roundingAmount).toBe(0);
    expect(t.duePayable).toBe(-1); // prepaid 14.97 > total 14.96 → reported by checks as OVERPAID
  });

  it('falls back to en16931 when the per-line rounding difference reaches the threshold', () => {
    // 300 × 0.99 gross: Vendure tax 300 × 0.16 = 48.00, EN 16931 tax = 249.00 × 19 % = 47.31
    const lines = Array.from({ length: 300 }, () => line(83, '1', VAT_19, { vendureTaxAmount: 16 }));
    const t = calculate(model({ lines }), { expectedTotalWithTax: 29700 });
    expect(t.taxCalculation).toBe('en16931');
    expect(t.vat[0].taxAmount).toBe(4731);
    expect(t.roundingAmount).toBe(69);
    expect(t.grandTotal + t.roundingAmount).toBe(29700);
    expect(t.warnings[0]).toMatch(/threshold/);
  });

  it('stays in vendure mode below the threshold', () => {
    // 100 × 0.99: Vendure 16.00 vs EN 15.77 → difference 0.23 < 0.50
    const lines = Array.from({ length: 100 }, () => line(83, '1', VAT_19, { vendureTaxAmount: 16 }));
    const t = calculate(model({ lines }), { expectedTotalWithTax: 9900 });
    expect(t.taxCalculation).toBe('vendure');
    expect(t.taxTotal).toBe(1600);
  });

  it('groups mixed rates in order of appearance and normalizes the rate', () => {
    const t = calculate(
      model({
        lines: [
          line(1869, '1', VAT_7, { vendureTaxAmount: 131 }),
          line(1000, '1', VAT_19, { vendureTaxAmount: 190 }),
          line(500, '2', { code: 'S', rate: '7.00' }, { vendureTaxAmount: 70 }),
        ],
      }),
    );
    expect(t.vat).toEqual([
      { category: { code: 'S', rate: '7' }, basisAmount: 2869, taxAmount: 201 },
      { category: { code: 'S', rate: '19' }, basisAmount: 1000, taxAmount: 190 },
    ]);
    expect(t.grandTotal).toBe(3869 + 391);
  });

  it('computes EN-style tax for amounts without a Vendure tax (e.g. goodwill allowance on a credit note)', () => {
    const t = calculate(
      model({
        type: 'credit_note',
        lines: [line(1000, '1', VAT_19, { vendureTaxAmount: 190 })],
        allowances: [{ amount: 300, reason: 'Kulanz', vat: VAT_19 }],
      }),
    );
    // base 10.00 − 3.00 = 7.00; tax = 1.90 (Vendure) − 0.57 (EN on the allowance) = 1.33
    expect(t.vat[0]).toMatchObject({ basisAmount: 700, taxAmount: 133 });
    expect(t).toMatchObject({ allowanceTotal: 300, taxBasisTotal: 700, grandTotal: 833 });
  });

  it('reports a difference to the expected total in vendure mode instead of hiding it', () => {
    const t = calculate(rounding('vendure'), { expectedTotalWithTax: 1500 });
    expect(t.expectedTotalDifference).toBe(3);
    expect(t.roundingAmount).toBe(0);
  });

  it('handles 0 % categories', () => {
    const t = calculate(
      model({ lines: [line(2500, '1', { code: 'AE', rate: '0', exemptionReasonCode: 'VATEX-EU-AE' }, { vendureTaxAmount: 0 })] }),
    );
    expect(t.vat).toEqual([{ category: { code: 'AE', rate: '0', exemptionReasonCode: 'VATEX-EU-AE' }, basisAmount: 2500, taxAmount: 0 }]);
  });

  it('rejects document-level charges without a VAT category', () => {
    expect(() => calculate(model({ lines: [line(100)], charges: [{ amount: 490, reason: 'Versand' }] }))).toThrow(/no VAT category/);
  });
});
