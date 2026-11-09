import { RequestContext } from '@vendure/core';

import { InvoiceNumberStrategy, NumberInput } from './types';

export interface DefaultInvoiceNumberStrategyOptions {
  /** Default: `RE` */
  invoicePrefix?: string;
  /** Default: `GS` */
  creditNotePrefix?: string;
  /** Minimum number of digits of the counter. Default: `5` */
  padding?: number;
  /** Start a new counter every year. Default: `true` */
  yearly?: boolean;
}

/**
 * Numbers like `RE-2026-00001` / `GS-2026-00001`, one counter per channel, document type and year.
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
