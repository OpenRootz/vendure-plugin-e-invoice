import { describe, expect, it } from 'vitest';

import { checkModel, defaultTemplate, pdfLabels, renderZugferdPdf, SAMPLE_KINDS, sampleModel, Seller, toCii } from '../../../src/core';

const seller: Seller = {
  name: 'Demo Shop GmbH',
  address: { line1: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE' },
  vatId: 'DE123456789',
  contact: { name: 'Buchhaltung', phone: '+49 30 1234567', email: 'buchhaltung@example.com' },
  electronicAddress: { scheme: 'EM', value: 'rechnung@example.com' },
};
const options = {
  seller,
  bank: { iban: 'DE02120300000000202051', bic: 'BYLADEM1001' },
  paymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  paymentTermDays: 14,
  number: 'ENTWURF',
};

describe('sampleModel', () => {
  for (const kind of SAMPLE_KINDS) {
    it(`${kind} passes the checks and is deterministic`, () => {
      const model = sampleModel(kind, options);
      expect(checkModel(model, ['zugferd'])).toEqual([]);
      expect(sampleModel(kind, options)).toEqual(model);
      expect(model.number).toBe('ENTWURF');
      expect(model.seller).toBe(seller);
    });

    it(`${kind} renders to a ZUGFeRD PDF`, async () => {
      const model = sampleModel(kind, options);
      const pdf = await renderZugferdPdf({
        model,
        xml: toCii(model, 'zugferd'),
        definition: defaultTemplate({ model, labels: pdfLabels('de') }),
        title: 'x',
      });
      expect(pdf.toString('latin1').startsWith('%PDF-1.7')).toBe(true);
    });
  }

  it('covers the cases the layout checks need', () => {
    expect(sampleModel('b2b-net', options).totals!.duePayable).toBeGreaterThan(0);
    expect(sampleModel('b2c-gross', options).meta.priceDisplay).toBe('gross');
    expect(sampleModel('b2c-gross', options).totals!.duePayable).toBe(0);
    const credit = sampleModel('credit-note', options);
    expect(credit.type).toBe('credit_note');
    expect(credit.precedingInvoices).toHaveLength(1);
    expect(sampleModel('many-lines', options).lines).toHaveLength(40);
    const worst = sampleModel('worst-case', options);
    expect(worst.totals!.vat.map((v) => v.category.rate).sort()).toEqual(['0', '19', '7']);
    expect(worst.buyer.address.line3).toBeDefined();
    expect(worst.delivery).toBeDefined();
  });

  it('uses the language for the texts', () => {
    expect(sampleModel('b2b-net', { ...options, language: 'en' }).lines[0].name).toMatch(/coffee/);
    expect(sampleModel('b2b-net', options).lines[0].name).toMatch(/Kaffee/);
  });

  it('reports missing payment terms as a real setup problem', () => {
    const model = sampleModel('b2b-net', { seller, number: 'ENTWURF' });
    expect(checkModel(model, ['zugferd']).map((i) => i.code)).toEqual(['PAYMENT_TERMS_REQUIRED']);
  });
});
