import { Order, RequestContext, VendureEvent } from '@vendure/core';

import { InvoiceIssue } from '../core';
import { EInvoiceDelivery } from '../entities/e-invoice-delivery.entity';
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

/**
 * A document should be sent ({@link EInvoiceDelivery}, status `queued`). Published by the default
 * {@link EmailPluginDeliveryStrategy} after the delivery row has been saved; the `eInvoiceDeliveryHandler` of the
 * EmailPlugin listens for it.
 *
 * @category Events
 */
export class EInvoiceDeliveryRequestedEvent extends VendureEvent {
  /** @internal */
  constructor(
    public ctx: RequestContext,
    public delivery: EInvoiceDelivery,
    public invoice: EInvoice,
  ) {
    super();
  }
}

/**
 * A delivery failed for good: the transport gave up, or the email could not be prepared. An admin can send the
 * document again from the dashboard.
 *
 * @category Events
 */
export class EInvoiceDeliveryFailedEvent extends VendureEvent {
  /** @internal */
  constructor(
    public ctx: RequestContext,
    public delivery: EInvoiceDelivery,
    public error: string,
  ) {
    super();
  }
}

/**
 * A buyer asked for their documents with the Shop API mutation `requestInvoiceDownloadLink`, and the order code
 * and email address matched. `sent` is `false` when the rate limit (option `delivery.requestLimit`) was reached or
 * the order has no issued documents.
 *
 * @category Events
 */
export class InvoiceDownloadLinkRequestedEvent extends VendureEvent {
  /** @internal */
  constructor(
    public ctx: RequestContext,
    public order: Order,
    public emailAddress: string,
    public deliveries: EInvoiceDelivery[],
    public sent: boolean,
  ) {
    super();
  }
}
