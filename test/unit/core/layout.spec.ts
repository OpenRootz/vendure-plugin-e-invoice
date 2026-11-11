import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  checkLayout,
  defaultFonts,
  defaultLayout,
  EInvoiceModel,
  layoutDocument,
  layoutFromV1,
  layoutPreset,
  LAYOUT_PRESETS,
  LayoutBlock,
  parseLayout,
  patchLayout,
  pdfLabels,
  PdfLayoutV2,
  probeLayout,
  renderZugferdPdf,
  SampleKind,
  sampleModel,
  Seller,
  toCii,
  toPt,
  v1Fields,
} from '../../../src/core';
import { legacyTemplate } from '../../fixtures/legacy-template';
import { extractFacturX } from '../../pdf-utils';

const OUT = path.join(__dirname, '../../__output__/pdf');

const seller: Seller = {
  name: 'Demo Shop GmbH',
  address: { line1: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE' },
  vatId: 'DE123456789',
  legalRegistration: { id: 'HRB 12345 B' },
  contact: { name: 'Buchhaltung', phone: '+49 30 1234567', email: 'buchhaltung@example.com' },
  electronicAddress: { scheme: 'EM', value: 'rechnung@example.com' },
};
const sample = (kind: SampleKind, language = 'de') =>
  sampleModel(kind, {
    seller,
    bank: { iban: 'DE02120300000000202051', bic: 'BYLADEM1001' },
    paymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    paymentTermDays: 14,
    number: 'RE-2026-00001',
    language,
  });
const fonts = defaultFonts();
const labels = pdfLabels('de');
const measure = (layout: PdfLayoutV2, model: EInvoiceModel, fit = false) => layoutDocument(layout, { model, labels }, fonts, { fit });
const edit = (layout: PdfLayoutV2, id: string, change: Partial<LayoutBlock>): PdfLayoutV2 => ({
  ...layout,
  blocks: layout.blocks.map((b) => (b.key === id ? { ...b, ...change } : b)),
});
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('layout model', () => {
  it('accepts the default layout', () => {
    const { layout, issues } = parseLayout(JSON.parse(JSON.stringify(defaultLayout())));
    expect(issues).toEqual([]);
    expect(layout).toEqual(defaultLayout());
  });

  it('drops props that are null (cleared GraphQL fields)', () => {
    const input = JSON.parse(JSON.stringify(defaultLayout()));
    input.blocks.push({
      key: 'img',
      type: 'image',
      visible: true,
      pages: 'first',
      frame: { x: 0, y: 0, w: 100, h: 100 },
      overflow: 'fixed',
      props: { assetId: null },
    });
    const { layout, issues } = parseLayout(input);
    expect(issues).toEqual([]);
    expect(layout!.blocks.find((b) => b.key === 'img')!.props).toEqual({});
  });

  it('rejects structural errors', () => {
    const base = defaultLayout();
    const errors = (layout: unknown) => codes(parseLayout(layout).issues);
    expect(errors({ ...base, version: 1 })).toEqual(['INVALID_LAYOUT']);
    expect(errors({ ...base, blocks: [...base.blocks, { ...base.blocks[0] }] })).toEqual(['DUPLICATE_KEY']);
    expect(errors(edit(base, 'logo', { type: 'banner' as never }))).toEqual(['UNKNOWN_BLOCK_TYPE']);
    expect(errors(edit(base, 'logo', { frame: { x: 1.5, y: 0, w: 10, h: 10 } }))).toEqual(['INVALID_FRAME']);
    expect(errors(edit(base, 'title', { anchor: { to: 'nope', gap: 0 } }))).toEqual(['ANCHOR_MISSING']);
    expect(errors(edit(base, 'deliveryAddress', { anchor: { to: 'closingText', gap: 0 } }))).toEqual(['ANCHOR_CYCLE']);
    expect(errors(edit(base, 'logo', { anchor: { to: 'lines', gap: 0 } }))).toEqual(['ANCHOR_BRANCH']);
    expect(errors(edit(base, 'introText', { props: { text: 'x'.repeat(2001) } }))).toEqual(['TEXT_TOO_LONG']);
    expect(errors(edit(base, 'introText', { props: { colour: 'red' } }))).toEqual(['UNKNOWN_PROPERTY']);
    expect(errors(edit(base, 'logo', { style: { color: 'red' } }))).toEqual(['INVALID_STYLE']);
    expect(errors({ ...base, blocks: Array.from({ length: 51 }, (_, i) => ({ ...base.blocks[0], key: `b${i}` })) })).toContain(
      'TOO_MANY_BLOCKS',
    );
  });

  it('migrates v1 settings and keeps the v1 fields as shortcuts', () => {
    const v2 = layoutFromV1({ accentColor: '#1a5fb4', introText: 'Hallo', footerText: 'Danke' });
    expect(v1Fields(v2)).toEqual({ accentColor: '#1a5fb4', introText: 'Hallo', closingText: '', footerText: 'Danke' });
    expect(layoutFromV1({ accentColor: 'red' }).theme.accentColor).toBe('#333333');
    const patched = patchLayout(v2, { closingText: 'Tschüss', introText: '' });
    expect(v1Fields(patched)).toMatchObject({ introText: '', closingText: 'Tschüss', footerText: 'Danke' });
  });
});

describe('layout checks', () => {
  const model = sample('worst-case');

  it('passes the default layout against the worst case', async () => {
    const layout = defaultLayout();
    const result = await measure(layout, model);
    expect(checkLayout(layout, result.measurement, model)).toEqual([]);
  });

  it('requires every mandatory field in a visible block, not fixed blocks', () => {
    const layout = defaultLayout();
    // the seller address is also in the footer, so the sender line may be hidden
    expect(checkLayout(edit(layout, 'senderLine', { visible: false }))).toEqual([]);
    const noFooter = edit(layout, 'footer', { visible: false });
    expect(checkLayout(noFooter).map((i) => i.message)).toEqual(['No visible block prints: Seller VAT ID or tax number']);
    const taxInDetails = edit(noFooter, 'details', { props: { fields: ['number', 'issueDate', 'deliveryDate', 'sellerTaxId'] } });
    expect(checkLayout(taxInDetails)).toEqual([]);
    expect(codes(checkLayout(edit(layout, 'totals', { visible: false })))).toEqual(['MANDATORY_CONTENT_MISSING']);
    // exemption notes are only needed when the invoice has exempt items
    const noExemption = edit(layout, 'exemptionNotes', { visible: false });
    expect(checkLayout(noExemption, undefined, sample('b2b-net'))).toEqual([]);
    expect(codes(checkLayout(noExemption, undefined, model))).toEqual(['MANDATORY_CONTENT_MISSING']);
  });

  it('reports clipped fixed blocks', async () => {
    const layout = edit(defaultLayout(), 'recipient', { frame: { x: 198, y: 478, w: 878, h: 200 } });
    const result = await measure(layout, model);
    const issues = checkLayout(layout, result.measurement, model);
    expect(issues).toEqual([expect.objectContaining({ level: 'error', code: 'CLIPPED', blockKey: 'recipient' })]);
  });

  it('shrinks the font of a block that does not fit at render time', async () => {
    const layout = edit(defaultLayout(), 'recipient', { frame: { x: 198, y: 478, w: 878, h: 300 } });
    const strict = await measure(layout, model);
    expect(strict.measurement.boxes.find((b) => b.key === 'recipient')!.overflowBy).toBeGreaterThan(0);
    const fitted = await measure(layout, model, true);
    expect(fitted.options.fontScale!.recipient).toBeLessThan(1);
    expect(fitted.measurement.boxes.find((b) => b.key === 'recipient')!.overflowBy).toBeUndefined();
    expect(fitted.issues).toEqual([expect.objectContaining({ level: 'warning', code: 'FONT_REDUCED', blockKey: 'recipient' })]);

    // below 6 pt it is printed beyond the frame instead (never clipped) and reported
    const tiny = await measure(edit(defaultLayout(), 'recipient', { frame: { x: 198, y: 478, w: 878, h: 60 } }), model, true);
    expect(tiny.options.fontScale!.recipient).toBeCloseTo(6 / 9, 2);
    expect(codes(tiny.issues)).toEqual(['LAYOUT_OVERFLOW']);
  });

  it('reports page bounds, overlaps, the DIN window, parallel growth and readability', async () => {
    const base = defaultLayout();
    expect(codes(checkLayout(edit(base, 'logo', { frame: { x: 1800, y: 169, w: 564, h: 212 } })))).toEqual(['OUT_OF_PAGE']);
    expect(codes(checkLayout(edit(base, 'logo', { frame: { x: 1337, y: 20, w: 564, h: 212 } })))).toEqual(['UNPRINTABLE_AREA']);

    const overlapping = edit(base, 'logo', { frame: { x: 1161, y: 400, w: 741, h: 200 } });
    const result = await measure(overlapping, model);
    const logoModel = model;
    expect(checkLayout(overlapping, result.measurement, logoModel).map((i) => i.message)).toEqual([]); // no logo in the input: nothing printed
    const withLogo = await layoutDocument(
      overlapping,
      { model, labels, logo: { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' } },
      fonts,
      { fit: false },
    );
    expect(codes(checkLayout(overlapping, withLogo.measurement, model))).toEqual(['OVERLAP']);

    expect(codes(checkLayout({ ...base, windowEnvelope: 'A' }))).toEqual(['NOT_IN_WINDOW', 'NOT_IN_WINDOW']);
    for (const preset of LAYOUT_PRESETS) {
      const layout = layoutPreset(preset);
      const presetResult = await measure(layout, model);
      expect(checkLayout(layout, presetResult.measurement, model), preset).toEqual([]);
    }
    expect(layoutPreset('din5008B').windowEnvelope).toBe('B');

    const parallel = edit(base, 'totals', { anchor: undefined, frame: { x: 1400, y: 848, w: 500, h: 0 } });
    expect(codes(checkLayout(edit(parallel, 'deliveryAddress', { frame: { x: 198, y: 848, w: 1100, h: 0 } })))).toEqual([
      'PARALLEL_GROWTH',
    ]);

    expect(codes(checkLayout({ ...base, theme: { ...base.theme, accentColor: '#ffee00' } }))).toEqual(['LOW_CONTRAST']);
    expect(codes(checkLayout(edit(base, 'footer', { style: { fontSize: 5 } })))).toEqual(['SMALL_FONT']);
    expect(codes(checkLayout({ ...base, theme: { ...base.theme, font: 'Comic' } }, undefined, undefined, { fonts: ['Roboto'] }))).toEqual([
      'UNKNOWN_FONT',
    ]);
  });
});

describe('layout engine', () => {
  it('keeps the flow of the previous template (positions relative to the title within 1 pt)', async () => {
    const model = sample('b2b-net');
    const v1 = { introText: 'Vielen Dank für Ihre Bestellung.', closingText: 'Mit freundlichen Grüßen' };
    // markers before each node of the old template (after the node's top margin, like the block start markers)
    const legacy = legacyTemplate({ model, labels, layout: v1 });
    const names = ['header', 'title', 'introText', 'lines', 'totals', 'payment', 'closingText'];
    legacy.content = (legacy.content as Record<string, unknown>[]).map((node, i) => {
      const { margin, ...rest } = node;
      return { stack: [{ text: ' ', fontSize: 0.01, lineHeight: 0, id: `b:${names[i]}:start` }, rest], margin };
    });
    const old = await probeLayout(legacy, fonts);
    const result = await measure(layoutFromV1(v1), model);
    const top = (id: string) => old.positions.find((p) => p.id === `b:${id}:start`)!.top;
    const box = (id: string) => result.measurement.boxes.find((b) => b.key === id)!;
    for (const id of names.slice(2)) {
      expect(toPt(box(id).y) - toPt(box('title').y), id).toBeCloseTo(top(id) - top('title'), -0.1);
      expect(Math.abs(toPt(box(id).y - box('title').y) - (top(id) - top('title'))), id).toBeLessThan(1);
    }
    const left = (id: string) => old.positions.find((p) => p.id === `b:${id}:start`)!.left;
    expect(Math.abs(toPt(box('lines').x) - left('lines'))).toBeLessThan(1);
  });

  it('places blocks anchored to fixed blocks and keeps minimum heights', async () => {
    const model = sample('b2b-net');
    let layout = edit(defaultLayout(), 'introText', { props: { text: 'Kurz' }, frame: { x: 198, y: 0, w: 1704, h: 300 } });
    layout = edit(layout, 'image', {});
    const result = await measure(layout, model);
    const box = (id: string) => result.measurement.boxes.find((b) => b.key === id)!;
    expect(box('introText').h).toBe(300);
    // the line table starts after the minimum height + gap
    expect(box('lines').y - (box('introText').y + 300)).toBeGreaterThanOrEqual(48);
    expect(box('lines').y - (box('introText').y + 300)).toBeLessThanOrEqual(50);
  });

  it('starts a second flow chain at its own position', async () => {
    const model = sample('b2b-net');
    let layout = edit(defaultLayout(), 'closingText', {
      anchor: undefined,
      frame: { x: 198, y: 2560, w: 1704, h: 0 },
      props: { text: 'Gruß' },
    });
    layout = edit(layout, 'exemptionNotes', {});
    const result = await measure(layout, model);
    const closing = result.measurement.boxes.find((b) => b.key === 'closingText')!;
    expect(Math.abs(closing.y - 2560)).toBeLessThanOrEqual(1);
    expect(result.issues).toEqual([]);

    const pushed = await measure(edit(layout, 'closingText', { frame: { x: 198, y: 1500, w: 1704, h: 0 } }), model);
    expect(codes(pushed.issues)).toEqual(['CHAIN_PUSHED']);
  });

  it('is deterministic', async () => {
    const model = sample('many-lines');
    const a = await measure(defaultLayout(), model);
    const b = await measure(defaultLayout(), model);
    expect(a.measurement).toEqual(b.measurement);
    expect(a.measurement.pageCount).toBeGreaterThan(1);
    expect(a.measurement.boxes.filter((x) => x.key === 'footer').map((x) => x.page)).toEqual([1, 2, 3].slice(0, a.measurement.pageCount));
  });

  it('keeps the blocks after line items that break across pages inside their frames', async () => {
    // pdfmake leaves the available width too large after a table breaks across pages (see compileLayout):
    // the amounts of the totals ended up beyond the page edge
    const layout = defaultLayout();
    const { definition, measurement } = await measure(layout, sample('many-lines'));
    const totals = layout.blocks.find((b) => b.key === 'totals')!;
    const cells: { text: string; id?: string }[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const table = (node as { table?: { body: { text: string }[][] } }).table;
      if (table?.body[0]?.[0]?.text === labels.totalNet) cells.push(...table.body.map((row) => row[1]));
      Object.values(node).forEach(visit);
    };
    visit(definition.content);
    expect(cells.length).toBeGreaterThan(2);
    cells.forEach((cell, i) => (cell.id = `amount-${i}`));
    const probe = await probeLayout(definition, fonts);
    const placed = probe.positions.filter((p) => p.id.startsWith('amount-'));
    expect(placed).toHaveLength(cells.length);
    for (const p of placed) {
      expect(p.page).toBe(measurement.pageCount);
      expect(p.left).toBeLessThan(toPt(totals.frame.x + totals.frame.w));
    }
  });
});

/** Unusual layouts, written to test/__output__/pdf for veraPDF and Mustang (`pnpm validate`). */
describe('exotic layouts', () => {
  fs.mkdirSync(OUT, { recursive: true });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" rx="6" fill="#1a5fb4"/></svg>';
  const layouts: Record<string, PdfLayoutV2> = {
    'layout-logo-bottom-left': edit(defaultLayout(), 'logo', { frame: { x: 198, y: 2400, w: 400, h: 150 }, style: { align: 'left' } }),
    'layout-totals-beside-lines': (() => {
      let l = edit(defaultLayout(), 'lines', { frame: { x: 198, y: 1100, w: 1150, h: 0 }, props: { columns: { position: false } } });
      l = edit(l, 'totals', { anchor: undefined, overflow: 'fixed', frame: { x: 1400, y: 1000, w: 502, h: 400 } });
      l = edit(l, 'exemptionNotes', { anchor: { to: 'lines', gap: 35 } });
      return l;
    })(),
    'layout-many-lines-header': {
      ...defaultLayout(),
      continuation: { top: 400, bottom: 339 },
      blocks: [
        ...defaultLayout().blocks,
        {
          key: 'followHeader',
          type: 'customText',
          visible: true,
          pages: 'following',
          overflow: 'fixed',
          frame: { x: 198, y: 169, w: 1704, h: 150 },
          props: { text: 'Rechnung {number} vom {issueDate}' },
          style: { bold: true },
        },
      ],
    },
  };
  for (const [name, layout] of Object.entries(layouts)) {
    it(`renders ${name} as a valid ZUGFeRD PDF`, async () => {
      expect(parseLayout(JSON.parse(JSON.stringify(layout))).issues).toEqual([]);
      const model = sample(name.includes('many') ? 'many-lines' : 'b2b-net');
      const result = await layoutDocument(layout, { model, labels, logo: { svg } }, fonts);
      expect(checkLayout(layout, result.measurement, model).filter((i) => i.level === 'error')).toEqual([]);
      const pdf = await renderZugferdPdf({ model, xml: toCii(model, 'zugferd'), definition: result.definition, title: 'x' });
      fs.writeFileSync(path.join(OUT, `${name}.pdf`), pdf);
      expect(extractFacturX(pdf)).toBe(toCii(model, 'zugferd'));
      expect(pdf.toString('latin1')).toContain('<pdfaid:part>3</pdfaid:part>');
    });
  }
});

describe('theme changes', () => {
  it('allows a larger base font: fixed blocks fit with a reduced font, only real clipping is an error', async () => {
    const model = sample('worst-case');
    const layout = defaultLayout();
    layout.theme.fontSize = 11;
    const strict = await measure(layout, model);
    expect(codes(checkLayout(layout, strict.measurement, model))).toContain('CLIPPED');
    const fitted = await measure(layout, model, true);
    expect(checkLayout(layout, fitted.measurement, model)).toEqual([]);
    expect(codes(fitted.issues)).toEqual(expect.arrayContaining(['FONT_REDUCED']));
  });
});
