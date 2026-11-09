import { describe, expect, it } from 'vitest';

import { calculate, checkModel, EInvoiceModel, IssueCode } from '../../../src/core';
import { line, model, VAT_19 } from '../../fixtures/model-builders';

function codes(m: EInvoiceModel, formats: Parameters<typeof checkModel>[1] = ['zugferd'], expected?: number) {
  m.totals = calculate(m, { expectedTotalWithTax: expected });
  return checkModel(m, formats).map((i) => i.code);
}

const valid = () => model({ lines: [line(1000, '1', VAT_19, { vendureTaxAmount: 190 })] });

describe('checkModel', () => {
  it('accepts a complete invoice', () => {
    expect(codes(valid(), ['zugferd', 'xrechnung-cii'], 1190)).toEqual([]);
  });

  it('requires calculated totals', () => {
    expect(checkModel(valid(), ['zugferd']).map((i) => i.code)).toContain('TOTALS_MISSING');
  });

  it('reports incomplete seller data with the missing fields', () => {
    const m = valid();
    m.seller.contact = {};
    m.seller.vatId = undefined;
    m.totals = calculate(m);
    const issues = checkModel(m, ['zugferd']);
    expect(issues.map((i) => i.code)).toEqual(['SELLER_INCOMPLETE', 'SELLER_TAX_ID_MISSING']);
    expect(issues[0].message).toContain('contact phone');
  });

  it('accepts a tax number instead of a VAT ID', () => {
    const m = valid();
    m.seller.vatId = undefined;
    m.seller.taxNumber = '11/222/33333';
    expect(codes(m)).toEqual([]);
  });

  it('requires an explicit category for 0 % rates', () => {
    const m = model({ lines: [line(1000, '1', { code: 'S', rate: '0' })] });
    expect(codes(m)).toEqual(['TAX_CATEGORY_MISSING']);
  });

  it.each<[string, IssueCode[]]>([
    ['Z', []],
    ['E', ['EXEMPTION_REASON_REQUIRED']],
    ['G', ['EXEMPTION_REASON_REQUIRED']],
    ['AE', ['EXEMPTION_REASON_REQUIRED', 'BUYER_VAT_ID_REQUIRED']],
  ])('category %s at 0 %% → %j', (code, expected) => {
    const m = model({ lines: [line(1000, '1', { code: code as 'Z', rate: '0' })] });
    expect(codes(m)).toEqual(expected);
  });

  it('rejects a non-zero rate for zero-rate categories', () => {
    expect(codes(model({ lines: [line(1000, '1', { code: 'Z', rate: '7' })] }))).toEqual(['INVALID_RATE_FOR_CATEGORY']);
  });

  it('checks intra-community supplies (K)', () => {
    const k = { code: 'K' as const, rate: '0', exemptionReasonCode: 'VATEX-EU-IC' };
    const m = model({ lines: [line(1000, '1', k)], deliveryDate: undefined });
    expect(codes(m)).toEqual(['BUYER_VAT_ID_REQUIRED', 'DELIVERY_INFO_REQUIRED', 'INTRA_COMMUNITY_SAME_COUNTRY']);

    const ok = model({ lines: [line(1000, '1', k)] });
    ok.buyer.vatId = 'ATU12345678';
    ok.buyer.address.countryCode = 'AT';
    ok.delivery = { address: { ...ok.buyer.address } };
    expect(codes(ok)).toEqual([]);
  });

  it('detects conflicting exemption reasons within one VAT group', () => {
    const m = model({
      lines: [
        line(1000, '1', { code: 'E', rate: '0', exemptionReason: '§ 4 Nr. 21 UStG' }),
        line(1000, '1', { code: 'E', rate: '0', exemptionReason: '§ 4 Nr. 14 UStG' }),
      ],
    });
    expect(codes(m)).toEqual(['EXEMPTION_REASON_CONFLICT']);
  });

  it('detects line amounts that do not add up', () => {
    const m = model({ lines: [line(1000, '2', VAT_19, { netAmount: 1999 })] });
    expect(codes(m)).toEqual(['LINE_AMOUNT_MISMATCH']);
  });

  it('flags totals that differ from the order total', () => {
    expect(codes(valid(), ['zugferd'], 1191)).toEqual(['TOTAL_MISMATCH']);
  });

  it('requires payment terms when an amount is due', () => {
    const m = valid();
    m.payment.terms = undefined;
    expect(codes(m)).toEqual(['PAYMENT_TERMS_REQUIRED']);
    m.payment.prepaidAmount = 1190;
    expect(codes(m)).toEqual([]);
  });

  it('detects overpayment', () => {
    const m = valid();
    m.payment.prepaidAmount = 2000;
    expect(codes(m)).toEqual(['OVERPAID']);
  });

  it('requires an IBAN for SEPA credit transfer', () => {
    const m = valid();
    m.payment.means = [{ code: '58', iban: '' }];
    expect(codes(m)).toEqual(['PAYMENT_ACCOUNT_MISSING']);
  });

  it('applies XRechnung rules only when an XRechnung format is requested', () => {
    const m = valid();
    m.buyerReference = '';
    m.buyer.electronicAddress = undefined;
    expect(codes(m, ['zugferd'])).toEqual([]);
    expect(codes(m, ['zugferd', 'xrechnung-ubl'])).toEqual(['BUYER_REFERENCE_MISSING', 'BUYER_ELECTRONIC_ADDRESS_MISSING']);
  });

  it('requires credit notes to reference the original invoice', () => {
    const m = valid();
    m.type = 'credit_note';
    expect(codes(m)).toEqual(['CREDIT_NOTE_REFERENCE_MISSING']);
  });

  it('validates dates and amount precision', () => {
    const m = valid();
    m.issueDate = '09.11.2026';
    m.amountDecimals = 3;
    expect(codes(m)).toEqual(['AMOUNT_PRECISION', 'INVALID_DATE']);
  });

  it('reports an empty invoice', () => {
    expect(codes(model())).toEqual(['EMPTY_INVOICE']);
  });
});
