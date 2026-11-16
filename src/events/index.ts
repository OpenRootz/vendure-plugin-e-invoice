import { RequestContext, VendureEvent } from '@vendure/core';

import { InvoiceIssue } from '../core';
import { EInvoice } from '../entities/e-invoice.entity';

/**
 * All files of an invoice or credit note have been rendered and stored, e.g. to send them by email.
 *
 * @example
 * ```ts
 * eventBus.ofType(EInvoiceIssuedEvent).subscribe((event) => {
 *   const url = downloadLinkService.fileLink(event.ctx, event.invoice, 'zugferd', 'guest');
 * });
 * ```
 *
 * @category Events
 */
export class EInvoiceIssuedEvent extends VendureEvent {
  /** @internal */
  constructor(
    public ctx: RequestContext,
    public invoice: EInvoice,
  ) {
    super();
  }
}

/**
 * The checks found problems (`issues`); the invoice is BLOCKED and no number has been reserved.
 *
 * @category Events
 */
export class EInvoiceBlockedEvent extends VendureEvent {
  /** @internal */
  constructor(
    public ctx: RequestContext,
    public invoice: EInvoice,
    public issues: InvoiceIssue[],
  ) {
    super();
  }
}

/**
 * Rendering or validation failed after the number was reserved; the invoice is FAILED. The job retries; an admin
 * can retry or void the invoice.
 *
 * @category Events
 */
export class EInvoiceFailedEvent extends VendureEvent {
  /** @internal */
  constructor(
    public ctx: RequestContext,
    public invoice: EInvoice,
    public error: string,
  ) {
    super();
  }
}
