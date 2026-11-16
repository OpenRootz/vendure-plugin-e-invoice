import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { defaultTemplate, EInvoiceModel, FACTURX_FILE_NAME, pdfLabels, renderZugferdPdf, toCii } from '../../../src/core';
import { scenarios } from '../../fixtures/scenarios';
import { extractFacturX } from '../../pdf-utils';

/** PDFs of all scenarios are written here; CI validates them with Mustang and veraPDF. */
const OUT = path.join(__dirname, '../../__output__/pdf');

function render(model: EInvoiceModel, language = model.language) {
  const labels = pdfLabels(language);
  return renderZugferdPdf({
    model,
    xml: toCii(model, 'zugferd'),
    definition: defaultTemplate({ model, labels, layout: { accentColor: '#1a5fb4', footerText: 'Vielen Dank für Ihren Einkauf.' } }),
    title: `${labels.invoice} ${model.number}`,
  });
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('pdfLabels', () => {
  it('falls back to English for unknown languages, also for names of inherited object properties', () => {
    for (const language of ['xx', 'constructor', 'toString', 'hasOwnProperty-DE']) {
      expect(pdfLabels(language)).toEqual(pdfLabels('en'));
      expect(pdfLabels('de', { [language]: { invoice: 'x' } }).invoice).toBe('Rechnung');
    }
    expect(pdfLabels('de-AT').invoice).toBe('Rechnung');
  });
});

describe('ZUGFeRD PDF', () => {
  fs.mkdirSync(OUT, { recursive: true });

  for (const s of scenarios) {
    it(`renders ${s.name}`, async () => {
      const pdf = await render(s.model);
      fs.writeFileSync(path.join(OUT, `${s.name}.pdf`), pdf);
      const raw = pdf.toString('latin1');
      expect(raw.startsWith('%PDF-1.7')).toBe(true);
      expect(raw).toContain(`(${FACTURX_FILE_NAME})`);
      expect(raw).toContain('/AFRelationship /Alternative');
      expect(raw).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');
      expect(raw).toContain('<pdfaid:part>3</pdfaid:part>');
      expect(extractFacturX(pdf)).toBe(toCii(s.model, 'zugferd'));
    });
  }

  it('renders an English invoice', async () => {
    const pdf = await render(scenarios[0].model, 'en');
    fs.writeFileSync(path.join(OUT, 'b2b-net-en.pdf'), pdf);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('renders an SVG logo', async () => {
    const model = scenarios[0].model;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect x="0" y="0" width="120" height="40" rx="6" fill="#1a5fb4"/></svg>';
    const definition = defaultTemplate({ model, labels: pdfLabels('de'), logo: { svg } });
    const pdf = await renderZugferdPdf({ model, xml: toCii(model, 'zugferd'), definition, title: 'x' });
    fs.writeFileSync(path.join(OUT, 'svg-logo.pdf'), pdf);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('never reads local files referenced by an SVG logo', async () => {
    const model = scenarios[0].model;
    const target = path.join(OUT, 'secret.png');
    fs.copyFileSync(path.join(__dirname, '../../fixtures/logo.png'), target);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="40"><image href="${target}" width="120" height="40"/></svg>`;
    const definition = defaultTemplate({ model, labels: pdfLabels('de'), logo: { svg } });
    await expect(renderZugferdPdf({ model, xml: toCii(model, 'zugferd'), definition, title: 'x' })).rejects.toThrow(/denied/);
  });

  it('is deterministic', async () => {
    const model = scenarios[0].model;
    expect(sha(await render(model))).toBe(sha(await render(model)));
  });

  it('does not let a template disable PDF/A or fetch remote resources', async () => {
    const model = scenarios[0].model;
    const definition = { ...defaultTemplate({ model, labels: pdfLabels('de') }), subset: undefined, version: '1.3', userPassword: 'x' };
    const pdf = await renderZugferdPdf({ model, xml: toCii(model, 'zugferd'), definition, title: 'x' });
    expect(pdf.toString('latin1').startsWith('%PDF-1.7')).toBe(true);
    expect(pdf.toString('latin1')).not.toContain('/Encrypt');

    const remote = { content: [{ image: 'https://example.com/logo.png' }] };
    await expect(renderZugferdPdf({ model, xml: '<x/>', definition: remote, title: 'x' })).rejects.toThrow(/denied/);
    const local = { content: [{ image: '/etc/hostname' }] };
    await expect(renderZugferdPdf({ model, xml: '<x/>', definition: local, title: 'x' })).rejects.toThrow();
  });
});

describe('default template', () => {
  const text = (model: EInvoiceModel, language = 'de') =>
    JSON.stringify(defaultTemplate({ model, labels: pdfLabels(language) }).content).replace(/\u00a0|\u202f/g, ' ');

  it('shows net prices for business buyers and the XML totals', () => {
    const t = text(scenarios.find((s) => s.name === 'b2b-net')!.model);
    expect(t).toContain('Rechnung RE-2026-00001');
    expect(t).toContain('10,00 €');
    expect(t).toContain('− 2,00 € Promotion: 10 % Herbstrabatt');
    expect(t).toContain('USt. 19 % auf 27,90 €');
    expect(t).toContain('33,20 €');
    expect(t).toContain('IBAN DE02 1203 0000 0000 2020 51');
    expect(t).toContain('Verwendungszweck: RE-2026-00001');
  });

  it('shows gross prices for consumers', () => {
    const model = scenarios.find((s) => s.name === 'b2c-gross-vendure-tax')!.model;
    const t = text({ ...model, lines: model.lines.map((l) => ({ ...l, display: undefined })) });
    // 3.35 net + 0.64 VAT → 3.99 gross
    expect(t).toContain('3,99 €');
    expect(t).toContain('Einzelpreis brutto');
    expect(t).toContain('Der Rechnungsbetrag wurde bereits beglichen.');
  });

  it('labels credit notes and references the corrected invoice', () => {
    const t = text(scenarios.find((s) => s.name === 'credit-note-partial')!.model);
    expect(t).toContain('Rechnungskorrektur GS-2026-00001');
    expect(t).toContain('Korrektur zur Rechnung RE-2026-00001 vom 09.11.2026');
    expect(t).toContain('Erstattungsbetrag');
    expect(t).not.toContain('Bereits bezahlt');
  });

  it('prints exemption reasons', () => {
    const t = text(scenarios.find((s) => s.name === 'intra-community-k')!.model);
    expect(t).toContain('Steuerfreie innergemeinschaftliche Lieferung');
    expect(t).toContain('Österreich');
  });

  it('falls back to English labels and accepts overrides', () => {
    expect(pdfLabels('fr').invoice).toBe('Invoice');
    expect(pdfLabels('de-AT', { de: { invoice: 'Faktura' } }).invoice).toBe('Faktura');
    expect(pdfLabels('de').units.H87).toBe('Stk.');
  });
});
