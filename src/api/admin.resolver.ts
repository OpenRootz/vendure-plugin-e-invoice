import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, Order, RequestContext } from '@vendure/core';

import { eInvoicePermission } from '../constants';
import { EInvoiceFormat } from '../core';
import { EInvoice, EInvoiceFile } from '../entities';
import { ChannelSettingsService, UpdateChannelSettingsInput } from '../services/channel-settings.service';
import { InvoiceService } from '../services/invoice.service';

const formatEnum = (f: EInvoiceFormat) => f.toUpperCase().replace(/-/g, '_');

@Resolver()
export class EInvoiceAdminResolver {
  constructor(
    private invoices: InvoiceService,
    private settings: ChannelSettingsService,
  ) {}

  @Query()
  @Allow(eInvoicePermission.Read)
  eInvoice(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
    return this.invoices.findOne(ctx, args.id);
  }

  @Query()
  @Allow(eInvoicePermission.Read)
  eInvoiceChannelSettings(@Ctx() ctx: RequestContext) {
    return this.settings.get(ctx);
  }

  @Mutation()
  @Allow(eInvoicePermission.Create)
  async createEInvoice(@Ctx() ctx: RequestContext, @Args() args: { orderId: ID }) {
    const invoice = await this.invoices.create(ctx, args.orderId);
    return this.invoices.findOne(ctx, invoice.id);
  }

  @Mutation()
  @Allow(eInvoicePermission.Update)
  async retryEInvoice(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
    const invoice = await this.invoices.retry(ctx, args.id);
    return this.invoices.findOne(ctx, invoice.id);
  }

  @Mutation()
  @Allow(eInvoicePermission.Update)
  updateEInvoiceChannelSettings(@Ctx() ctx: RequestContext, @Args() args: { input: UpdateChannelSettingsInput }) {
    return this.settings.update(ctx, args.input);
  }
}

@Resolver('EInvoice')
export class EInvoiceEntityResolver {
  @ResolveField()
  type(@Parent() invoice: EInvoice) {
    return invoice.type.toUpperCase();
  }

  @ResolveField()
  formats(@Parent() invoice: EInvoice) {
    return invoice.formats.map(formatEnum);
  }

  @ResolveField()
  issues(@Parent() invoice: EInvoice) {
    return invoice.issues ?? [];
  }

  @ResolveField()
  files(@Parent() invoice: EInvoice) {
    return invoice.files ?? [];
  }
}

@Resolver('EInvoiceFile')
export class EInvoiceFileResolver {
  @ResolveField()
  format(@Parent() file: EInvoiceFile) {
    return formatEnum(file.format);
  }
}

@Resolver('Order')
export class EInvoiceOrderResolver {
  constructor(private invoices: InvoiceService) {}

  @ResolveField()
  @Allow(eInvoicePermission.Read)
  eInvoices(@Ctx() ctx: RequestContext, @Parent() order: Order) {
    return this.invoices.findByOrder(ctx, order.id);
  }
}
