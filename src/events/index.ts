import { RequestContext, VendureEvent } from '@vendure/core';

import { InvoiceIssue } from '../core';
import { EInvoice } from '../entities/e-invoice.entity';

/** All files of an invoice or credit note have been rendered and stored. */
export class EInvoiceIssuedEvent extends VendureEvent {
  constructor(
    public ctx: RequestContext,
    public invoice: EInvoice,
  ) {
    super();
  }
}

/** The checks found problems; no number has been reserved. */
export class EInvoiceBlockedEvent extends VendureEvent {
  constructor(
    public ctx: RequestContext,
    public invoice: EInvoice,
    public issues: InvoiceIssue[],
  ) {
    super();
  }
}

/** Rendering failed after the number was reserved. The job retries; an admin can retry or void the invoice. */
export class EInvoiceFailedEvent extends VendureEvent {
  constructor(
    public ctx: RequestContext,
    public invoice: EInvoice,
    public error: string,
  ) {
    super();
  }
}
