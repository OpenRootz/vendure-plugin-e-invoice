import type { InvoiceIssue } from './checks';
import { Seller } from './model';

/**
 * Format checks for the seller data: country code, VAT ID, IBAN, BIC and email addresses.
 *
 * They are warnings, not blocking issues: an unusual value can be right (a new VAT ID format, a non-EU seller), and
 * the seller data is entered once in the settings, where the warnings are shown. Offline only; VAT IDs are not
 * checked against VIES.
 */

export type SellerFormatWarningCode =
  'SELLER_COUNTRY_INVALID' | 'SELLER_VAT_ID_INVALID' | 'SELLER_IBAN_INVALID' | 'SELLER_BIC_INVALID' | 'SELLER_EMAIL_INVALID';

export interface SellerFormatWarning extends Omit<InvoiceIssue, 'code'> {
  code: SellerFormatWarningCode;
}

/** ISO 3166-1 alpha-2 (officially assigned codes). */
export const COUNTRY_CODES: ReadonlySet<string> = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
    'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
    'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
    'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
    'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
    'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
);

/** IBAN length per country (SWIFT IBAN registry). */
// prettier-ignore
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22,
  GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30,
  KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20,
  MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/** Structure of VAT IDs per EU member state (VIES), without the prefix. Greece uses `EL`, Northern Ireland `XI`. */
const EU_VAT_ID_FORMATS: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^[1-9]\d{1,9}$/,
  SE: /^\d{10}01$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

const BIC_RE = /^[A-Z]{4}([A-Z]{2})[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const present = (v: string | undefined | null): v is string => typeof v === 'string' && v.trim() !== '';

/** Upper case without whitespace, for country codes, VAT IDs, IBANs and BICs. */
export function normalizeCode(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

export function isCountryCode(value: string): boolean {
  return COUNTRY_CODES.has(value);
}

/** Country length and ISO 13616 check digits (mod 97). Expects a normalized IBAN. */
export function isValidIban(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const length = IBAN_LENGTHS[iban.slice(0, 2)];
  if (length === undefined ? iban.length < 15 || iban.length > 34 : iban.length !== length) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

export function isValidBic(bic: string): boolean {
  const match = BIC_RE.exec(bic);
  return !!match && (isCountryCode(match[1]) || match[1] === 'XK');
}

/**
 * Why a VAT ID does not match the structure of its EU member state, or `undefined` if it matches or has no EU
 * prefix (non-EU VAT IDs are not checked). Expects a normalized VAT ID.
 */
export function vatIdProblem(vatId: string): string | undefined {
  const prefix = vatId.slice(0, 2);
  if (prefix === 'GR') return 'Greek VAT IDs start with EL, not GR';
  const format = EU_VAT_ID_FORMATS[prefix];
  if (!format || format.test(vatId.slice(2))) return undefined;
  return `it does not match the format of ${prefix} VAT IDs`;
}

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/**
 * Format warnings for the seller data. Values are normalized before checking (`de` is fine, the settings store it
 * as `DE`); empty fields are skipped, `checkSeller` reports them.
 */
export function checkSellerFormats(seller: Seller, bank?: { iban?: string; bic?: string }): SellerFormatWarning[] {
  const warnings: SellerFormatWarning[] = [];
  const add = (code: SellerFormatWarningCode, message: string, path: string) => warnings.push({ code, message, path });

  const country = seller.address.countryCode;
  if (present(country) && !isCountryCode(normalizeCode(country))) {
    add('SELLER_COUNTRY_INVALID', `Country code "${country}" is not an ISO 3166-1 alpha-2 code (e.g. DE)`, 'seller.address.countryCode');
  }
  if (present(seller.vatId)) {
    const problem = vatIdProblem(normalizeCode(seller.vatId));
    if (problem) add('SELLER_VAT_ID_INVALID', `VAT ID "${seller.vatId}": ${problem}`, 'seller.vatId');
  }
  if (present(bank?.iban) && !isValidIban(normalizeCode(bank.iban))) {
    add('SELLER_IBAN_INVALID', `IBAN "${bank.iban}" has a wrong length or check digits`, 'seller.bank.iban');
  }
  if (present(bank?.bic) && !isValidBic(normalizeCode(bank.bic))) {
    add('SELLER_BIC_INVALID', `BIC "${bank.bic}" is not a valid BIC (8 or 11 characters, e.g. COBADEFFXXX)`, 'seller.bank.bic');
  }
  if (present(seller.contact.email) && !isValidEmail(seller.contact.email)) {
    add('SELLER_EMAIL_INVALID', `Contact email "${seller.contact.email}" is not a valid email address`, 'seller.contact.email');
  }
  const electronic = seller.electronicAddress;
  if (electronic?.scheme === 'EM' && present(electronic.value) && !isValidEmail(electronic.value)) {
    add('SELLER_EMAIL_INVALID', `Electronic address "${electronic.value}" is not a valid email address`, 'seller.electronicAddress.value');
  }
  return warnings;
}
