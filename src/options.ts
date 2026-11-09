import { OrderState } from '@vendure/core';

/**
 * Options for {@link EInvoicePlugin.init}.
 */
export interface EInvoicePluginOptions {
  /** Secret for signing download links (HMAC-SHA256). Required. */
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
}

export type ResolvedEInvoicePluginOptions = Required<EInvoicePluginOptions>;

export function resolveOptions(options: EInvoicePluginOptions): ResolvedEInvoicePluginOptions {
  if (!options?.secret || options.secret.length < 32) {
    throw new Error('EInvoicePlugin: `secret` is required and must be at least 32 characters long');
  }
  return {
    issueOnStates: ['PaymentSettled'],
    autoCreditNotes: true,
    taxCalculation: 'vendure',
    ...options,
  };
}
