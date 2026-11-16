import { Order, OrderLine, OrderState, Payment, RequestContext } from '@vendure/core';

import {
  Buyer,
  CreditAllocationInput,
  EInvoiceModel,
  Money,
  IsoDate,
  PaymentMeans,
  PdfFonts,
  PdfLabels,
  Seller,
  VatCategory,
} from './core';
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
 *
 * @category Mapping
 */
export interface EInvoiceMappingHooks {
  /**
   * BT-72 actual delivery date.
   *
   * @default the issue date
   */
  deliveryDate?: (ctx: RequestContext, order: Order) => IsoDate | undefined | Promise<IsoDate | undefined>;
  /**
   * VAT category of an order line, shipping line or surcharge.
   *
   * @default the `eInvoice*` custom fields of the applicable TaxRate; rate > 0 without a category → `S`
   */
  taxCategory?: (
    ctx: RequestContext,
    input: { order: Order; line?: OrderLine; rate: number; defaultCategory?: VatCategory; buyer: Buyer },
  ) => VatCategory | undefined;
  /**
   * Payment means (BG-16) for a settled or authorized payment.
   *
   * @default the `eInvoicePaymentMeansCode` custom field of the payment method, else `ZZZ` with the method name
   */
  paymentMeans?: (ctx: RequestContext, input: { order: Order; payment: Payment; seller: Seller }) => PaymentMeans | undefined;
  /**
   * BT-130 unit code (UN/ECE Rec. 20).
   *
   * @default `H87` (piece)
   */
  unitCode?: (ctx: RequestContext, line: OrderLine) => string | undefined;
  /**
   * Language of the invoice.
   *
   * @default the channel default language
   */
  language?: (ctx: RequestContext, order: Order) => string | undefined;
  /**
   * Price display in the PDF.
   *
   * @default net for business buyers, gross otherwise
   */
  priceDisplay?: (ctx: RequestContext, order: Order, buyer: Buyer) => 'gross' | 'net' | undefined;
  /**
   * How an amount-only refund (Vendure's default) is split across the VAT rates of the invoice.
   *
   * @default proportionally to the remaining gross amount per rate; the rounding remainder goes to the largest share
   */
  creditAllocation?: (ctx: RequestContext, input: CreditAllocationInput) => Money[];
  /** Last-mile escape hatch: change anything in the model before the checks run. */
  transformModel?: (ctx: RequestContext, model: EInvoiceModel, order: Order) => EInvoiceModel | Promise<EInvoiceModel>;
}

/**
 * A duration in seconds, or a string like `'15m'`, `'1h'`, `'7d'`.
 *
 * @category Plugin
 */
export type Duration = number | `${number}${'s' | 'm' | 'h' | 'd'}`;

/**
 * Lifetime and base URL of the signed download links ({@link EInvoicePluginOptions.downloadLinks}).
 *
 * @category Plugin
 */
export interface DownloadLinkOptions {
  /**
   * Lifetime of links for guests, e.g. in the order confirmation email.
   *
   * @default '7d'
   */
  guestTtl?: Duration;
  /**
   * Lifetime of links in the Shop API for the customer who owns the order.
   *
   * @default '1h'
   */
  ownerTtl?: Duration;
  /**
   * Lifetime of links in the Admin API.
   *
   * @default '15m'
   */
  adminTtl?: Duration;
  /**
   * Public base URL of the Vendure server, e.g. `https://shop.example.com`. Set it when Vendure runs behind a proxy,
   * or when links are created outside of a request, e.g. in jobs.
   *
   * @default taken from the API request
   */
  baseUrl?: string;
}

/**
 * Options for {@link EInvoicePlugin.init}.
 *
 * @category Plugin
 */
export interface EInvoicePluginOptions {
  /** Secret for signing download links (HMAC-SHA256). Required, at least 32 characters. */
  secret: string;
  /**
   * Order states that trigger automatic invoice creation (when auto-issue is enabled for the channel).
   *
   * @default ['PaymentSettled']
   */
  issueOnStates?: OrderState[];
  /**
   * Create credit notes automatically on settled refunds, cancellations and modifications.
   *
   * @default true
   */
  autoCreditNotes?: boolean;
  /**
   * How VAT per rate is computed.
   * - `'vendure'`: sum of Vendure's per-line taxes per rate; the invoice matches the order total exactly.
   * - `'en16931'`: tax computed on the sum per rate (EN 16931), any difference goes into the rounding amount (BT-114).
   *
   * @default 'vendure'
   */
  taxCalculation?: 'vendure' | 'en16931';
  /**
   * In `'vendure'` mode: if Vendure's tax for a rate differs from the EN 16931 calculation by at least this
   * many minor units, the invoice falls back to `'en16931'`.
   *
   * @default 50 (0.50 with two decimals)
   */
  roundingFallbackThreshold?: number;
  /**
   * IANA time zone used for issue and due dates, e.g. `'Europe/Berlin'`.
   *
   * @default the time zone of the server process
   */
  timeZone?: string;
  /**
   * Runtime validation of every rendered document, e.g. with a {@link KositHttpValidator}. Validation belongs in CI
   * first (see the README); at runtime it is optional.
   * - `'off'`: no validation
   * - `'report'`: validate, store the result on the invoice, issue anyway
   * - `'enforce'`: a rejected document is not issued but FAILED (it keeps its number; fix and retry, or void it)
   *
   * @default { validator: new NoopValidator(), mode: 'off' }
   */
  validation?: { validator: InvoiceValidator; mode: 'off' | 'report' | 'enforce' };
  /** Signed download links. All links are signed with `secret` and expire. */
  downloadLinks?: DownloadLinkOptions;
  /**
   * Make the buyer custom fields (VAT ID, buyer reference, Leitweg-ID, PO number) readable and writable in the Shop API.
   *
   * @default true
   */
  exposeBuyerFieldsInShop?: boolean;
  /**
   * Format of the invoice numbers and the gap-free counter they draw from.
   *
   * @default new DefaultInvoiceNumberStrategy() (`RE-2026-00001` / `GS-2026-00001`)
   */
  numberStrategy?: InvoiceNumberStrategy;
  /**
   * Where the seller data (name, address, VAT ID, bank account, payment terms) comes from.
   *
   * @default new ChannelSettingsSellerStrategy() (the e-invoice settings of the channel)
   */
  sellerStrategy?: SellerDataStrategy;
  /**
   * How the buyer is mapped from the order and customer.
   *
   * @default new DefaultBuyerDataStrategy()
   */
  buyerStrategy?: BuyerDataStrategy;
  /**
   * Which files an invoice gets.
   *
   * @default new DefaultInvoiceFormatStrategy() (ZUGFeRD; plus XRechnung when the buyer has a Leitweg-ID)
   */
  formatStrategy?: InvoiceFormatStrategy;
  /**
   * Where the rendered files are stored, e.g. {@link LocalFileInvoiceStorageStrategy} or a custom strategy.
   *
   * @default new DatabaseInvoiceStorageStrategy()
   */
  storage?: InvoiceStorageStrategy;
  /**
   * Layout of the ZUGFeRD PDF.
   *
   * @default new DefaultTemplatePdfStrategy() (the channel's layout from the layout editor)
   */
  pdfStrategy?: InvoicePdfStrategy;
  /** Fonts and labels of the PDF. */
  pdf?: {
    /**
     * TTF fonts by family name; the first family is the default.
     *
     * @default Roboto (Latin, Greek, Cyrillic)
     */
    fonts?: PdfFonts;
    /** Override labels of the default template per language, e.g. `{ de: { invoice: 'Faktura' } }`. */
    translations?: Record<string, Partial<PdfLabels>>;
  };
  /**
   * Hooks for single mapping decisions (delivery date, VAT category, payment means, …).
   *
   * @default {}
   */
  mapping?: EInvoiceMappingHooks;
}

/**
 * The options with all defaults applied.
 *
 * @internal
 */
export type ResolvedEInvoicePluginOptions = Required<Omit<EInvoicePluginOptions, 'downloadLinks'>> & {
  downloadLinks: { guestTtl: number; ownerTtl: number; adminTtl: number; baseUrl?: string };
};

/** @internal */
export function resolveOptions(options: EInvoicePluginOptions): ResolvedEInvoicePluginOptions {
  if (!options?.secret || options.secret.length < 32) {
    throw new Error('EInvoicePlugin: `secret` is required and must be at least 32 characters long');
  }
  const links = options.downloadLinks ?? {};
  if (links.baseUrl !== undefined && !/^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(links.baseUrl)) {
    throw new Error(`EInvoicePlugin: \`downloadLinks.baseUrl\` must be an http(s) URL without query or fragment, got ${links.baseUrl}`);
  }
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

/**
 * Duration in seconds.
 *
 * @internal
 */
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
