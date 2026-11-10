import { Order, OrderLine, OrderState, Payment, RequestContext } from '@vendure/core';

import { Buyer, CreditAllocationInput, EInvoiceModel, Money, IsoDate, PaymentMeans, PdfFonts, PdfLabels, Seller, VatCategory } from './core';
import { DefaultBuyerDataStrategy } from './strategies/buyer-data-strategy';
import { DefaultInvoiceFormatStrategy } from './strategies/format-strategy';
import {
  BuyerDataStrategy,
  InvoiceFormatStrategy,
  InvoiceNumberStrategy,
  InvoicePdfStrategy,
  InvoiceStorageStrategy,
  InvoiceValidator,
  SellerDataStrategy,
} from './strategies/types';
import { NoopValidator } from './strategies/validator';
import { DefaultInvoiceNumberStrategy } from './strategies/number-strategy';
import { DefaultTemplatePdfStrategy } from './strategies/pdf-strategy';
import { ChannelSettingsSellerStrategy } from './strategies/seller-data-strategy';
import { DatabaseInvoiceStorageStrategy } from './strategies/storage-strategy';

/**
 * Small hooks to adjust single mapping decisions without replacing a whole strategy.
 * Every hook is optional; returning `undefined` falls back to the default.
 */
export interface EInvoiceMappingHooks {
  /** BT-72. Default: the issue date. */
  deliveryDate?: (ctx: RequestContext, order: Order) => IsoDate | undefined | Promise<IsoDate | undefined>;
  /**
   * VAT category of an order line, shipping line or surcharge. Default: the `eInvoice*` custom fields of the
   * applicable TaxRate; rate > 0 without a category → `S`.
   */
  taxCategory?: (
    ctx: RequestContext,
    input: { order: Order; line?: OrderLine; rate: number; defaultCategory?: VatCategory; buyer: Buyer },
  ) => VatCategory | undefined;
  /**
   * Payment means (BG-16) for a settled or authorized payment. Default: the `eInvoicePaymentMeansCode`
   * custom field of the payment method, else `ZZZ` with the method name.
   */
  paymentMeans?: (ctx: RequestContext, input: { order: Order; payment: Payment; seller: Seller }) => PaymentMeans | undefined;
  /** BT-130 unit code (UN/ECE Rec. 20). Default: `H87` (piece). */
  unitCode?: (ctx: RequestContext, line: OrderLine) => string | undefined;
  /** Language of the invoice. Default: the channel default language. */
  language?: (ctx: RequestContext, order: Order) => string | undefined;
  /** Price display in the PDF. Default: net for business buyers, gross otherwise. */
  priceDisplay?: (ctx: RequestContext, order: Order, buyer: Buyer) => 'gross' | 'net' | undefined;
  /**
   * How an amount-only refund (Vendure's default) is split across the VAT rates of the invoice.
   * Default: proportionally to the remaining gross amount per rate; the rounding remainder goes to the largest share.
   */
  creditAllocation?: (ctx: RequestContext, input: CreditAllocationInput) => Money[];
  /** Last-mile escape hatch: change anything in the model before the checks run. */
  transformModel?: (ctx: RequestContext, model: EInvoiceModel, order: Order) => EInvoiceModel | Promise<EInvoiceModel>;
}

/** A duration in seconds, or a string like `'15m'`, `'1h'`, `'7d'`. */
export type Duration = number | `${number}${'s' | 'm' | 'h' | 'd'}`;

export interface DownloadLinkOptions {
  /** Links for guests, e.g. in the order confirmation email. Default: `'7d'`. */
  guestTtl?: Duration;
  /** Links in the Shop API for the customer who owns the order. Default: `'1h'`. */
  ownerTtl?: Duration;
  /** Links in the Admin API. Default: `'15m'`. */
  adminTtl?: Duration;
  /**
   * Public base URL of the Vendure server, e.g. `https://shop.example.com`. Default: taken from the API request
   * (set it when Vendure runs behind a proxy, or when links are created outside of a request, e.g. in jobs).
   */
  baseUrl?: string;
}

/**
 * Options for {@link EInvoicePlugin.init}.
 */
export interface EInvoicePluginOptions {
  /** Secret for signing download links (HMAC-SHA256). Required, at least 32 characters. */
  secret: string;
  /** Order states that trigger automatic invoice creation. Default: `['PaymentSettled']`. */
  issueOnStates?: OrderState[];
  /** Create credit notes automatically on settled refunds, cancellations and modifications. Default: `true`. */
  autoCreditNotes?: boolean;
  /**
   * How VAT per rate is computed. Default: `'vendure'`.
   * - `'vendure'`: sum of Vendure's per-line taxes per rate; the invoice matches the order total exactly.
   * - `'en16931'`: tax computed on the sum per rate (EN 16931), any difference goes into the rounding amount (BT-114).
   */
  taxCalculation?: 'vendure' | 'en16931';
  /**
   * In `'vendure'` mode: if Vendure's tax for a rate differs from the EN 16931 calculation by at least this
   * many minor units, the invoice falls back to `'en16931'`. Default: `50` (0.50 with two decimals).
   */
  roundingFallbackThreshold?: number;
  /** IANA time zone used for issue and due dates. Default: the time zone of the server process. */
  timeZone?: string;
  /**
   * Runtime validation of every rendered document. Default: off (validation belongs in CI; see the README).
   * - `'report'`: validate, store the result on the invoice, issue anyway
   * - `'enforce'`: a rejected document is not issued but FAILED (it keeps its number; fix and retry, or void it)
   */
  validation?: { validator: InvoiceValidator; mode: 'off' | 'report' | 'enforce' };
  /** Signed download links. All links are signed with `secret` and expire. */
  downloadLinks?: DownloadLinkOptions;
  /** Make the buyer custom fields (VAT ID, buyer reference, Leitweg-ID, PO number) readable and writable in the Shop API. Default: `true`. */
  exposeBuyerFieldsInShop?: boolean;
  numberStrategy?: InvoiceNumberStrategy;
  sellerStrategy?: SellerDataStrategy;
  buyerStrategy?: BuyerDataStrategy;
  formatStrategy?: InvoiceFormatStrategy;
  storage?: InvoiceStorageStrategy;
  /** Layout of the ZUGFeRD PDF. Default: the built-in template. */
  pdfStrategy?: InvoicePdfStrategy;
  pdf?: {
    /** TTF fonts by family name; the first family is the default. Default: Roboto (Latin, Greek, Cyrillic). */
    fonts?: PdfFonts;
    /** Override labels of the default template per language, e.g. `{ de: { invoice: 'Faktura' } }`. */
    translations?: Record<string, Partial<PdfLabels>>;
  };
  mapping?: EInvoiceMappingHooks;
}

export type ResolvedEInvoicePluginOptions = Required<Omit<EInvoicePluginOptions, 'downloadLinks'>> & {
  downloadLinks: { guestTtl: number; ownerTtl: number; adminTtl: number; baseUrl?: string };
};

export function resolveOptions(options: EInvoicePluginOptions): ResolvedEInvoicePluginOptions {
  if (!options?.secret || options.secret.length < 32) {
    throw new Error('EInvoicePlugin: `secret` is required and must be at least 32 characters long');
  }
  const links = options.downloadLinks ?? {};
  return {
    issueOnStates: ['PaymentSettled'],
    autoCreditNotes: true,
    taxCalculation: 'vendure',
    roundingFallbackThreshold: 50,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    exposeBuyerFieldsInShop: true,
    numberStrategy: new DefaultInvoiceNumberStrategy(),
    sellerStrategy: new ChannelSettingsSellerStrategy(),
    buyerStrategy: new DefaultBuyerDataStrategy(),
    formatStrategy: new DefaultInvoiceFormatStrategy(),
    storage: new DatabaseInvoiceStorageStrategy(),
    pdfStrategy: new DefaultTemplatePdfStrategy(),
    validation: { validator: new NoopValidator(), mode: 'off' },
    pdf: {},
    mapping: {},
    ...stripUndefined(options),
    downloadLinks: {
      guestTtl: parseDuration(links.guestTtl ?? '7d', 'downloadLinks.guestTtl'),
      ownerTtl: parseDuration(links.ownerTtl ?? '1h', 'downloadLinks.ownerTtl'),
      adminTtl: parseDuration(links.adminTtl ?? '15m', 'downloadLinks.adminTtl'),
      baseUrl: links.baseUrl?.replace(/\/+$/, ''),
    },
  };
}

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/** Duration in seconds. */
export function parseDuration(value: Duration, name = 'duration'): number {
  const match = typeof value === 'number' ? null : /^(\d+(?:\.\d+)?)([smhd])$/.exec(value);
  const seconds = typeof value === 'number' ? value : match ? Number(match[1]) * UNIT_SECONDS[match[2] as 's'] : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`EInvoicePlugin: \`${name}\` must be a positive number of seconds or a string like '1h', got ${value}`);
  }
  return Math.round(seconds);
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
