import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { checkModel, EInvoiceFormat, EInvoiceModel, toCii, toUbl } from '../../../src/core';
import { scenarios } from '../../fixtures/scenarios';

const GOLDEN = path.join(__dirname, '../../golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

export function render(model: EInvoiceModel, format: EInvoiceFormat): string {
  switch (format) {
    case 'zugferd':
      return toCii(model, 'zugferd');
    case 'xrechnung-cii':
      return toCii(model, 'xrechnung');
    case 'xrechnung-ubl':
      return toUbl(model);
  }
}

describe.each(scenarios)('scenario $name', (s) => {
  it('passes the plausibility checks', () => {
    expect(checkModel(s.model, s.formats)).toEqual([]);
  });

  it.each(s.formats)('%s matches the golden file', (format) => {
    const xml = render(s.model, format);
    const file = path.join(GOLDEN, `${s.name}.${format}.xml`);
    if (UPDATE || !fs.existsSync(file)) {
      fs.writeFileSync(file, xml);
    }
    expect(xml).toBe(fs.readFileSync(file, 'utf8'));
  });

  it('is deterministic', () => {
    expect(render(s.model, 'zugferd')).toBe(render(s.model, 'zugferd'));
  });
});

describe('golden directory', () => {
  it('contains no stale files', () => {
    const expected = new Set(scenarios.flatMap((s) => s.formats.map((f) => `${s.name}.${f}.xml`)));
    const stale = fs.readdirSync(GOLDEN).filter((f) => f.endsWith('.xml') && !expected.has(f));
    expect(stale).toEqual([]);
  });
});
