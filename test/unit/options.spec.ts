import { describe, expect, it } from 'vitest';

import { resolveOptions } from '../../src/options';

describe('resolveOptions', () => {
  it('rejects a missing or short secret', () => {
    expect(() => resolveOptions({ secret: '' })).toThrow(/secret/);
    expect(() => resolveOptions({ secret: 'short' })).toThrow(/secret/);
  });

  it('applies defaults', () => {
    const o = resolveOptions({ secret: 'x'.repeat(32) });
    expect(o.issueOnStates).toEqual(['PaymentSettled']);
    expect(o.autoCreditNotes).toBe(true);
    expect(o.taxCalculation).toBe('vendure');
  });
});
