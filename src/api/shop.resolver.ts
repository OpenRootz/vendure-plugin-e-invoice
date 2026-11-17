import { Args, Mutation, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, Order, RequestContext } from '@vendure/core';

import { EInvoice } from '../entities';
import { EInvoiceDeliveryService } from '../services/delivery.service';
import { InvoiceService } from '../services/invoice.service';

/**
 * Shop API: only ISSUED documents, never the snapshot or internal states. Orders are only reachable through
 * Vendure's own ownership checks (`activeCustomer.orders`, `orderByCode`).
 */
@Resolver('Order')
export class EInvoiceShopOrderResolver {
  constructor(private invoices: InvoiceService) {}

  @ResolveField()
  async eInvoices(@Ctx() ctx: RequestContext, @Parent() order: Order) {
    return (await this.invoices.findByOrder(ctx, order.id)).filter((i) => i.status === 'ISSUED');
  }
}

@Resolver('EInvoice')
export class EInvoiceShopEntityResolver {
  @ResolveField()
  type(@Parent() invoice: EInvoice) {
    return invoice.type.toUpperCase();
  }

  @ResolveField()
  files(@Parent() invoice: EInvoice) {
    return invoice.files ?? [];
  }
}

@Resolver()
export class EInvoiceShopDeliveryResolver {
  constructor(private deliveries: EInvoiceDeliveryService) {}

  /** Public. The answer is the same whether or not anything matched, so it cannot be used to probe orders. */
  @Mutation()
  async requestInvoiceDownloadLink(@Ctx() ctx: RequestContext, @Args() args: { orderCode: string; emailAddress: string }) {
    await this.deliveries.requestDocuments(ctx, args.orderCode, args.emailAddress);
    return { success: true };
  }
}
