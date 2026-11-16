import { RequestContext } from '@vendure/core';

import { InvoiceNumberStrategy, NumberInput } from './types';

/**
 * Options of the {@link DefaultInvoiceNumberStrategy}.
 *
 * @category Strategies
 */
export interface DefaultInvoiceNumberStrategyOptions {
  /**
   * Prefix of invoice numbers.
   *
   * @default 'RE'
   */
  invoicePrefix?: string;
  /**
   * Prefix of credit note numbers.
   *
   * @default 'GS'
   */
  creditNotePrefix?: string;
  /**
   * Minimum number of digits of the counter.
   *
   * @default 5
   */
  padding?: number;
  /**
   * Start a new counter every year (the year becomes part of the number).
   *
   * @default true
   */
  yearly?: boolean;
}

/**
 * Numbers like `RE-2026-00001` / `GS-2026-00001`, one counter per channel, document type and year.
 *
 * @example
 * ```ts
 * EInvoicePlugin.init({
 *   secret: process.env.E_INVOICE_SECRET!,
 *   numberStrategy: new DefaultInvoiceNumberStrategy({ invoicePrefix: 'INV', creditNotePrefix: 'CN' }),
 * });
 * ```
 *
 * @category Strategies
 */
export class DefaultInvoiceNumberStrategy implements InvoiceNumberStrategy {
  private readonly options: Required<DefaultInvoiceNumberStrategyOptions>;

  constructor(options: DefaultInvoiceNumberStrategyOptions = {}) {
    this.options = { invoicePrefix: 'RE', creditNotePrefix: 'GS', padding: 5, yearly: true, ...options };
  }

  sequenceKey(ctx: RequestContext, input: NumberInput): string {
    const parts = [ctx.channel.code, input.type];
    if (this.options.yearly) parts.push(input.issueDate.slice(0, 4));
    return parts.join('|');
  }

  format(ctx: RequestContext, input: NumberInput & { value: number }): string {
    const prefix = input.type === 'credit_note' ? this.options.creditNotePrefix : this.options.invoicePrefix;
    const counter = String(input.value).padStart(this.options.padding, '0');
    return this.options.yearly ? `${prefix}-${input.issueDate.slice(0, 4)}-${counter}` : `${prefix}-${counter}`;
  }
}
