import { describe, expect, it } from 'vitest';

import {
  compareDecimal,
  divRoundHalfUp,
  formatAmount,
  fromUnits,
  isZeroDecimal,
  multiply,
  normalizeDecimal,
  parseDecimal,
  percentOf,
} from '../../../src/core';

describe('money', () => {
  it('parses decimal strings exactly', () => {
    expect(parseDecimal('19')).toEqual({ value: 19n, scale: 0 });
    expect(parseDecimal('5.5')).toEqual({ value: 55n, scale: 1 });
    expect(parseDecimal('-0.125')).toEqual({ value: -125n, scale: 3 });
    expect(() => parseDecimal('1e3')).toThrow();
    expect(() => parseDecimal('19,5')).toThrow();
    expect(() => parseDecimal('')).toThrow();
  });

  it('normalizes and compares decimals', () => {
    expect(normalizeDecimal('19.00')).toBe('19');
    expect(normalizeDecimal('05.50')).toBe('5.5');
    expect(normalizeDecimal('0.0')).toBe('0');
    expect(normalizeDecimal('100')).toBe('100');
    expect(isZeroDecimal('0.00')).toBe(true);
    expect(compareDecimal('7', '7.0')).toBe(0);
    expect(compareDecimal('5.5', '19')).toBe(-1);
  });

  it('rounds half away from zero', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(divRoundHalfUp(-4n, 3n)).toBe(-1n);
    expect(() => divRoundHalfUp(1n, 0n)).toThrow();
  });

  it('computes VAT amounts without floating point errors', () => {
    expect(percentOf(2790, '19')).toBe(530); // 5.301
    expect(percentOf(1257, '19')).toBe(239); // 2.3883
    expect(percentOf(1000, '5.5')).toBe(55);
    expect(percentOf(1050, '7')).toBe(74); // 73.5 → 74 (half up)
    expect(percentOf(-1050, '7')).toBe(-74);
    expect(percentOf(Number.MAX_SAFE_INTEGER - 1, '0')).toBe(0);
  });

  it('multiplies price and quantity', () => {
    expect(multiply(1000, '2')).toBe(2000);
    expect(multiply(333, '1.5')).toBe(500); // 499.5 → 500
  });

  it('formats minor units with string math', () => {
    expect(formatAmount(1999, 2)).toBe('19.99');
    expect(formatAmount(5, 2)).toBe('0.05');
    expect(formatAmount(-1999, 2)).toBe('-19.99');
    expect(formatAmount(0, 2)).toBe('0.00');
    expect(formatAmount(1500, 0)).toBe('1500');
    expect(formatAmount(1234567, 3)).toBe('1234.567');
    expect(() => formatAmount(1.5, 2)).toThrow();
  });

  it('converts currency units to minor units', () => {
    expect(fromUnits(0.5, 2)).toBe(50);
    expect(fromUnits(0.5, 0)).toBe(1);
    expect(fromUnits(1, 3)).toBe(1000);
  });
});
