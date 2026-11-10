import { Address, EInvoiceModel, Money, PaymentMeans } from '../../model';
import { percentOf } from '../../money';
import type { Formatters, PdfLabels } from '../i18n';
import type { LayoutBlock } from '../layout';

/** A pdfmake node. Typed loosely on purpose (https://pdfmake.github.io/docs/). */
export type PdfNode = Record<string, unknown> | string;

/** Image as a PNG/JPEG data URL or SVG markup (loaded by the server, never a URL). */
export type PdfImage = { dataUrl: string } | { svg: string };

/** What a block renderer gets. Widths are in pt. */
export interface BlockContext {
  model: EInvoiceModel;
  labels: PdfLabels;
  f: Formatters;
  accent: string;
  block: LayoutBlock;
  /** Width of the block's frame in pt */
  width: number;
  /** Height of the block's frame in pt (minimum height for `grow` blocks) */
  height: number;
  logo?: PdfImage;
  /** Images of `image` blocks by asset id */
  images: Record<string, PdfImage>;
  /** Fixed blocks only: the current page and the page count */
  page?: number;
  pageCount?: number;
}

/** Renders the content of one block; `null` when there is nothing to show (the block collapses). */
export type BlockRenderer = (ctx: BlockContext) => PdfNode | null;

export const GREY = '#555555';
export const LIGHT = '#dddddd';

export function addressLines(
  name: string,
  address: Address,
  contact: string | undefined,
  homeCountry: string,
  labels: PdfLabels,
): string[] {
  const country = address.countryCode && address.countryCode !== homeCountry ? countryName(address.countryCode, labels.locale) : undefined;
  return [
    name,
    contact && contact !== name ? contact : '',
    address.line1,
    address.line2 ?? '',
    address.line3 ?? '',
    `${address.postalCode} ${address.city}`.trim(),
    country ?? '',
  ].filter((l) => l);
}

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Amount including VAT, for gross display: Vendure's tax where known, else computed from the rate. */
export function withTax(amount: Money, rate: string, vendureTax: Money | undefined): Money {
  return amount + (vendureTax ?? percentOf(amount, rate));
}

export function formatIban(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

export function sepaAccount(model: EInvoiceModel) {
  return model.payment.means.find((m): m is Extract<PaymentMeans, { code: '58' }> => m.code === '58' && 'iban' in m && !!m.iban);
}

export const textProp = (block: LayoutBlock): string | undefined => {
  const t = block.props?.text;
  return typeof t === 'string' && t.trim() ? t : undefined;
};
