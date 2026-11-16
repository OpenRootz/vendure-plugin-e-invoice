import { ID, InjectableStrategy, Order, RequestContext } from '@vendure/core';

import { Address, Buyer, EInvoiceFormat, EInvoiceType, IsoDate, PdfDocDefinition, PdfTemplateInput, Seller } from '../core';

/**
 * Input of the {@link InvoiceNumberStrategy}.
 *
 * @category Strategies
 */
export interface NumberInput {
  type: EInvoiceType;
  order: Order;
  issueDate: IsoDate;
}

/**
 * Decides what an invoice number looks like and which gap-free counter it draws from.
 * The counter itself is owned by the plugin (row-locked, inside the issuing transaction).
 * Default: {@link DefaultInvoiceNumberStrategy}.
 *
 * @category Strategies
 */
export interface InvoiceNumberStrategy extends InjectableStrategy {
  /** Key of the counter this document draws from, e.g. `default|invoice|2026`. */
  sequenceKey(ctx: RequestContext, input: NumberInput): string | Promise<string>;
  /** Render the number from the counter value. Must be unique per channel. */
  format(ctx: RequestContext, input: NumberInput & { value: number }): string;
}

/**
 * Bank account of the seller, used for SEPA credit transfer (payment means 58).
 *
 * @category Strategies
 */
export interface BankAccount {
  iban: string;
  bic?: string;
  accountName?: string;
}

/**
 * Result of the {@link SellerDataStrategy}.
 *
 * @category Strategies
 */
export interface SellerData {
  seller: Seller;
  bank?: BankAccount;
  /** BT-20 payment terms text for amounts that are still due */
  paymentTerms?: string;
  /** Days until the due date (BT-9) for amounts that are still due */
  paymentTermDays?: number;
}

/**
 * Provides the seller data of an order. Default: {@link ChannelSettingsSellerStrategy}.
 *
 * @category Strategies
 */
export interface SellerDataStrategy extends InjectableStrategy {
  /** Seller data for the order, or `undefined` if e-invoicing is not set up for its channel. */
  getSeller(ctx: RequestContext, order: Order): Promise<SellerData | undefined>;
}

/**
 * Result of the {@link BuyerDataStrategy}.
 *
 * @category Strategies
 */
export interface BuyerData {
  buyer: Buyer;
  /** BT-10 */
  buyerReference: string;
  /** BT-13 */
  orderReference?: string;
  /** BG-15, only when it differs from the buyer address */
  delivery?: { name?: string; address: Address };
  /** BT-22 notes from the order */
  notes?: string[];
  /** Leitweg-ID, if the buyer is a German public authority */
  leitwegId?: string;
}

/**
 * Maps the buyer of an order (BG-7) and the order references. Default: {@link DefaultBuyerDataStrategy}.
 *
 * @category Strategies
 */
export interface BuyerDataStrategy extends InjectableStrategy {
  /** Buyer data for the order. */
  getBuyer(ctx: RequestContext, order: Order): Promise<BuyerData>;
}

/**
 * Decides which files an invoice gets (ZUGFeRD PDF, XRechnung CII / UBL). Default: {@link DefaultInvoiceFormatStrategy}.
 *
 * @category Strategies
 */
export interface InvoiceFormatStrategy extends InjectableStrategy {
  /** Formats to render for the order, at least one. */
  formats(ctx: RequestContext, order: Order, buyer: BuyerData): EInvoiceFormat[] | Promise<EInvoiceFormat[]>;
}

/**
 * A file passed to {@link InvoiceStorageStrategy.save}.
 *
 * @category Strategies
 */
export interface StoredFileInput {
  /** Suggested key, e.g. `default/2026/RE-2026-00001.xml` */
  key: string;
  data: Buffer;
  mimeType: string;
  channelId: ID;
}

/**
 * Where generated files are kept. There is deliberately no `delete`: issued documents are immutable
 * and must be retained (§147 AO, at least 8 years). Default: {@link DatabaseInvoiceStorageStrategy}; also included:
 * {@link LocalFileInvoiceStorageStrategy}.
 *
 * @category Strategies
 */
export interface InvoiceStorageStrategy extends InjectableStrategy {
  /** Store the file and return an opaque storage ID. */
  save(ctx: RequestContext, file: StoredFileInput): Promise<string>;
  /** Read a file by the storage ID returned from `save`. */
  read(ctx: RequestContext, storageId: string): Promise<Buffer>;
}

/**
 * Builds the layout of the ZUGFeRD PDF as a pdfmake document definition.
 * Return layout only: PDF/A-3b, the embedded XML, metadata and fonts are enforced by the plugin,
 * so a custom template cannot produce a non-compliant e-invoice. Images must be data URLs.
 * Default: {@link DefaultTemplatePdfStrategy}.
 *
 * @category Strategies
 */
export interface InvoicePdfStrategy extends InjectableStrategy {
  /** Layout of the PDF for one document. */
  buildDocDefinition(ctx: RequestContext, input: PdfTemplateInput): PdfDocDefinition | Promise<PdfDocDefinition>;
}

/**
 * A message of a {@link ValidationReport}.
 *
 * @category Strategies
 */
export interface ValidationMessage {
  level: 'error' | 'warning' | 'information';
  /** Rule ID, e.g. `BR-CO-16` */
  code?: string;
  text: string;
  /** XPath of the element, if the validator reports one */
  location?: string;
}

/**
 * Result of an {@link InvoiceValidator}.
 *
 * @category Strategies
 */
export interface ValidationReport {
  /** `false` if the document must not be issued (EN 16931 / XRechnung rules violated) */
  valid: boolean;
  messages: ValidationMessage[];
  /** Name of the validator, e.g. `KoSIT Validator 1.6.3` */
  validator: string;
}

/**
 * A rendered document passed to an {@link InvoiceValidator}.
 *
 * @category Strategies
 */
export interface ValidationInput {
  format: EInvoiceFormat;
  fileName: string;
  /** The rendered file (PDF or XML) */
  data: Buffer;
  /** The XML of the document; for the ZUGFeRD PDF the embedded CII XML */
  xml: string;
}

/**
 * Optional runtime validation of rendered documents, e.g. against a KoSIT validator running as a sidecar
 * ({@link KositHttpValidator}). Enabled with the `validation.mode` option. Default: {@link NoopValidator}.
 *
 * @category Strategies
 */
export interface InvoiceValidator extends InjectableStrategy {
  /**
   * Validate one rendered file. Throw if the validator cannot be reached: the error is stored in the invoice's
   * validation summary and the document counts as not valid.
   */
  validate(ctx: RequestContext, input: ValidationInput): Promise<ValidationReport>;
}
