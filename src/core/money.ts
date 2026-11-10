import { Decimal, Money } from './model';

/**
 * Integer and decimal-string arithmetic for invoice amounts.
 * Products are computed with BigInt, so `amount × rate` can never lose precision.
 */

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** A decimal string as an exact fraction: `value / 10^scale`. */
export interface ParsedDecimal {
  value: bigint;
  scale: number;
}

export function parseDecimal(input: Decimal): ParsedDecimal {
  const s = String(input).trim();
  if (!DECIMAL_RE.test(s)) {
    throw new Error(`Invalid decimal: "${input}"`);
  }
  const negative = s.startsWith('-');
  const [int, frac = ''] = (negative ? s.slice(1) : s).split('.');
  const value = BigInt(int + frac);
  return { value: negative ? -value : value, scale: frac.length };
}

/** Normalizes a decimal string (`"19.00"` → `"19"`, `"05.50"` → `"5.5"`), e.g. for grouping keys. */
export function normalizeDecimal(input: Decimal): Decimal {
  const { value, scale } = parseDecimal(input);
  const s = formatScaled(value, scale);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function isZeroDecimal(input: Decimal): boolean {
  return parseDecimal(input).value === 0n;
}

export function compareDecimal(a: Decimal, b: Decimal): number {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const scale = Math.max(pa.scale, pb.scale);
  const va = pa.value * 10n ** BigInt(scale - pa.scale);
  const vb = pb.value * 10n ** BigInt(scale - pb.scale);
  return va === vb ? 0 : va < vb ? -1 : 1;
}

/** `num / den` rounded half away from zero (commercial rounding). `den` must be positive. */
export function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error('Denominator must be positive');
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const q = abs / den;
  const r = abs % den;
  const rounded = 2n * r >= den ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** Converts a BigInt back to a safe `Money` value. */
export function toMoney(value: bigint): Money {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Amount out of range: ${value}`);
  return n;
}

export function assertMoney(value: unknown, label = 'amount'): asserts value is Money {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer amount in minor units, got ${String(value)}`);
  }
}

/** `amount × percent / 100`, rounded half up. E.g. `percentOf(2790, "19")` → `530`. */
export function percentOf(amount: Money, percent: Decimal): Money {
  const { value, scale } = parseDecimal(percent);
  return toMoney(divRoundHalfUp(BigInt(amount) * value, 100n * 10n ** BigInt(scale)));
}

/** `price × quantity`, rounded half up to minor units. */
export function multiply(price: Money, quantity: Decimal): Money {
  const { value, scale } = parseDecimal(quantity);
  return toMoney(divRoundHalfUp(BigInt(price) * value, 10n ** BigInt(scale)));
}

export function sum(values: Money[]): Money {
  return values.reduce((s, v) => s + v, 0);
}

/** Formats minor units as a plain decimal string: `formatAmount(-1999, 2)` → `"-19.99"`. */
export function formatAmount(amount: Money, decimals: number): string {
  assertMoney(amount);
  return formatScaled(BigInt(amount), decimals);
}

function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const int = scale === 0 ? digits : digits.slice(0, -scale);
  const frac = scale === 0 ? '' : '.' + digits.slice(-scale);
  return (negative ? '-' : '') + int + frac;
}

/** Converts a value in currency units (e.g. `0.5`) to minor units for the given decimals. */
export function fromUnits(units: number, decimals: number): Money {
  return toMoney(divRoundHalfUp(BigInt(Math.round(units * 1_000_000)) * 10n ** BigInt(decimals), 1_000_000n));
}

function toScale(d: ParsedDecimal, scale: number): bigint {
  return d.value * 10n ** BigInt(scale - d.scale);
}

/** `a + b` for decimal strings. */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const scale = Math.max(pa.scale, pb.scale);
  return normalizeDecimal(formatScaled(toScale(pa, scale) + toScale(pb, scale), scale));
}

/** `a − b` for decimal strings. */
export function subtractDecimal(a: Decimal, b: Decimal): Decimal {
  return addDecimal(a, String(b).startsWith('-') ? String(b).slice(1) : `-${b}`);
}

/** `amount × numerator / denominator`, rounded half up. E.g. the share of a line amount for a partial quantity. */
export function scaleMoney(amount: Money, numerator: Decimal, denominator: Decimal): Money {
  const n = parseDecimal(numerator);
  const d = parseDecimal(denominator);
  if (d.value <= 0n) throw new Error(`Denominator must be positive, got ${denominator}`);
  return toMoney(divRoundHalfUp(BigInt(amount) * n.value * 10n ** BigInt(d.scale), d.value * 10n ** BigInt(n.scale)));
}

/** Net part of a gross amount: `gross × 100 / (100 + rate)`, rounded half up. */
export function netFromGross(gross: Money, percent: Decimal): Money {
  return scaleMoney(gross, '100', addDecimal('100', percent));
}
