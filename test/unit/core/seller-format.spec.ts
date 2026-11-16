import { describe, expect, it } from 'vitest';

import { checkSellerFormats, isValidBic, isValidIban, Seller, vatIdProblem } from '../../../src/core';
import { model } from '../../fixtures/model-builders';

const seller = (override: Partial<Seller> = {}): Seller => ({ ...model().seller, ...override });
const codes = (s: Seller, bank?: { iban?: string; bic?: string }) => checkSellerFormats(s, bank).map((w) => w.code);

describe('checkSellerFormats', () => {
  it('accepts valid seller data', () => {
    expect(codes(seller(), { iban: 'DE02120300000000202051', bic: 'BYLADEM1001' })).toEqual([]);
  });

  it('accepts values that only differ in case and spaces, since saving normalizes them', () => {
    const s = seller({ vatId: 'de 123456789', address: { ...model().seller.address, countryCode: 'de' } });
    expect(codes(s, { iban: 'de02 1203 0000 0000 2020 51', bic: 'byladem1001' })).toEqual([]);
  });

  it('skips empty fields (checkSeller reports missing ones)', () => {
    const s = seller({ vatId: undefined, address: { ...model().seller.address, countryCode: '' }, contact: {} });
    expect(codes(s, {})).toEqual([]);
  });

  it('warns about an unknown country code', () => {
    const s = seller({ address: { ...model().seller.address, countryCode: 'GER' } });
    expect(checkSellerFormats(s)).toEqual([
      expect.objectContaining({ code: 'SELLER_COUNTRY_INVALID', path: 'seller.address.countryCode' }),
    ]);
  });

  it('warns about a VAT ID that does not match its EU member state', () => {
    expect(codes(seller({ vatId: 'DE12345' }))).toEqual(['SELLER_VAT_ID_INVALID']);
    expect(checkSellerFormats(seller({ vatId: 'GR123456789' }))[0].message).toContain('EL');
  });

  it('does not check VAT IDs without an EU prefix', () => {
    expect(codes(seller({ vatId: 'CHE-123.456.789 MWST' }))).toEqual([]);
  });

  it('warns about IBAN, BIC and email addresses', () => {
    const s = seller({ contact: { name: 'A', email: 'buchhaltung@' }, electronicAddress: { scheme: 'EM', value: 'rechnung.example.com' } });
    expect(codes(s, { iban: 'DE00 1234 5678', bic: 'BYLADE' })).toEqual([
      'SELLER_IBAN_INVALID',
      'SELLER_BIC_INVALID',
      'SELLER_EMAIL_INVALID',
      'SELLER_EMAIL_INVALID',
    ]);
  });

  it('checks the electronic address only for the email scheme', () => {
    expect(codes(seller({ electronicAddress: { scheme: '0204', value: '991-12345-67' } }))).toEqual([]);
  });
});

describe('format helpers', () => {
  it.each([
    ['DE02120300000000202051', true],
    ['DE02120300000000202052', false], // check digits
    ['DE0212030000000020205', false], // length
    ['AT611904300234573201', true],
    ['NL91ABNA0417164300', true],
    ['XY461234567890AB', true], // unknown country: only the check digits (and 15–34 characters)
    ['XY471234567890AB', false],
    ['DE00', false],
  ])('IBAN %s → %s', (iban, valid) => {
    expect(isValidIban(iban)).toBe(valid);
  });

  it.each([
    ['COBADEFFXXX', true],
    ['COBADEFF', true],
    ['COBAZZFF', false], // no such country
    ['COBADEF', false],
  ])('BIC %s → %s', (bic, valid) => {
    expect(isValidBic(bic)).toBe(valid);
  });

  it.each([
    ['DE123456789', undefined],
    ['ATU12345678', undefined],
    ['NL123456789B01', undefined],
    ['FR12345678901', undefined],
    ['SE123456789001', undefined],
    ['ATU1234567', 'it does not match the format of AT VAT IDs'],
    ['US123', undefined],
  ])('VAT ID %s', (vatId, problem) => {
    expect(vatIdProblem(vatId)).toBe(problem);
  });
});
