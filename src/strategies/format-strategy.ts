import { Order, RequestContext } from '@vendure/core';

import { EInvoiceFormat } from '../core';

import { BuyerData, InvoiceFormatStrategy } from './types';

/**
 * Default: always ZUGFeRD (PDF with embedded XML, readable by humans and machines);
 * additionally an XRechnung (CII) when the buyer has a Leitweg-ID (German public authorities).
 *
 * @category Strategies
 */
export class DefaultInvoiceFormatStrategy implements InvoiceFormatStrategy {
  formats(_ctx: RequestContext, _order: Order, buyer: BuyerData): EInvoiceFormat[] {
    return buyer.leitwegId ? ['zugferd', 'xrechnung-cii'] : ['zugferd'];
  }
}
