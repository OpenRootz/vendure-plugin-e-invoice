import { Order, RequestContext } from '@vendure/core';

import { Address, Buyer } from '../core';

import { BuyerData, BuyerDataStrategy } from './types';

type OrderAddress = Order['billingAddress'];

/**
 * Default buyer mapping:
 * - address and name from the billing address (fallback: shipping address), company name first;
 * - VAT ID, buyer reference, Leitweg-ID and PO number from the order custom fields, falling back to the customer;
 * - electronic address: the Leitweg-ID (scheme 0204) if set, else the customer email (scheme EM);
 * - buyer reference (BT-10): Leitweg-ID, else the buyer reference field, else the order code;
 * - delivery address only when the shipping address differs from the billing address.
 *
 * Expects `order.customer` to be loaded.
 *
 * @category Strategies
 */
export class DefaultBuyerDataStrategy implements BuyerDataStrategy {
  async getBuyer(_ctx: RequestContext, order: Order): Promise<BuyerData> {
    const billing = hasAddress(order.billingAddress) ? order.billingAddress : order.shippingAddress;
    const customer = order.customer;
    const field = (name: 'eInvoiceVatId' | 'eInvoiceBuyerReference' | 'eInvoiceLeitwegId') =>
      clean(order.customFields?.[name]) ?? clean(customer?.customFields?.[name]);

    const vatId = field('eInvoiceVatId');
    const leitwegId = field('eInvoiceLeitwegId');
    const company = clean(billing.company);
    const personName = clean(billing.fullName) ?? clean([customer?.firstName, customer?.lastName].filter(Boolean).join(' '));
    const email = clean(customer?.emailAddress);

    const buyer: Buyer = {
      name: company ?? personName ?? '',
      isBusiness: !!company || !!vatId,
      address: toAddress(billing),
      vatId,
      electronicAddress: leitwegId ? { scheme: '0204', value: leitwegId } : email ? { scheme: 'EM', value: email } : undefined,
      contact: company && (personName || email) ? { name: personName, email, phone: clean(billing.phoneNumber) } : undefined,
    };

    const shipping = order.shippingAddress;
    const delivery =
      hasAddress(shipping) && billing !== shipping && !sameAddress(toAddress(shipping), buyer.address)
        ? { name: clean(shipping.company) ?? clean(shipping.fullName), address: toAddress(shipping) }
        : undefined;

    const note = clean(order.customFields?.eInvoiceNote);
    return {
      buyer,
      buyerReference: leitwegId ?? field('eInvoiceBuyerReference') ?? order.code,
      orderReference: clean(order.customFields?.eInvoicePurchaseOrder),
      delivery,
      notes: note ? [note] : [],
      leitwegId,
    };
  }
}

function clean(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function hasAddress(a: OrderAddress | undefined): a is OrderAddress {
  return !!a && !!(clean(a.streetLine1) || clean(a.city));
}

/** @internal */
export function toAddress(a: OrderAddress | undefined): Address {
  return {
    line1: clean(a?.streetLine1) ?? '',
    line2: clean(a?.streetLine2),
    postalCode: clean(a?.postalCode) ?? '',
    city: clean(a?.city) ?? '',
    countryCode: clean(a?.countryCode)?.toUpperCase() ?? '',
    subdivision: clean(a?.province),
  };
}

function sameAddress(a: Address, b: Address): boolean {
  const norm = (x: Address) =>
    [x.line1, x.line2, x.postalCode, x.city, x.countryCode].map((v) => (v ?? '').toLowerCase().replace(/\s+/g, ' ')).join('|');
  return norm(a) === norm(b);
}
