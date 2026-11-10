import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, ListQueryOptions, Order, OrderService, RequestContext } from '@vendure/core';

import { eInvoicePermission } from '../constants';
import { EInvoiceFormat } from '../core';
import { EInvoice, EInvoiceFile } from '../entities';
import { ChannelSettingsService, UpdateChannelSettingsInput } from '../services/channel-settings.service';
import { InvoiceService, ManualCreditNoteInput } from '../services/invoice.service';

const formatEnum = (f: EInvoiceFormat) => f.toUpperCase().replace(/-/g, '_');

type Filter = Record<string, unknown> & { _and?: Filter[]; _or?: Filter[] };

/** The API exposes `type` as an enum (INVOICE), the entity stores `invoice`: translate the filter values. */
function translateTypeFilter(filter: Filter | undefined): Filter | undefined {
  if (!filter) return filter;
  const out: Filter = { ...filter };
  if (out.type && typeof out.type === 'object') {
    const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
    out.type = Object.fromEntries(
      Object.entries(out.type).map(([op, v]) => [op, Array.isArray(v) ? v.map(lower) : lower(v)]),
    );
  }
  if (out._and) out._and = out._and.map((f) => translateTypeFilter(f) as Filter);
  if (out._or) out._or = out._or.map((f) => translateTypeFilter(f) as Filter);
  return out;
}

@Resolver()
export class EInvoiceAdminResolver {
  constructor(
    private invoices: InvoiceService,
    private settings: ChannelSettingsService,
  ) {}

  @Query()
  @Allow(eInvoicePermission.Read)
  eInvoices(@Ctx() ctx: RequestContext, @Args() args: { options?: ListQueryOptions<EInvoice> }) {
    const options = args.options && { ...args.options, filter: translateTypeFilter(args.options.filter as Filter) };
    return this.invoices.findAll(ctx, options as ListQueryOptions<EInvoice>);
  }

  @Query()
  @Allow(eInvoicePermission.Read)
  eInvoiceSetupStatus(@Ctx() ctx: RequestContext) {
    return this.settings.setupStatus(ctx);
  }

  @Query()
  @Allow(eInvoicePermission.Read)
  eInvoicePreview(@Ctx() ctx: RequestContext, @Args() args: { orderId: ID }) {
    return this.invoices.preview(ctx, args.orderId);
  }

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
    return invoice ? this.invoices.findOne(ctx, invoice.id) : null;
  }

  @Mutation()
  @Allow(eInvoicePermission.Create)
  async createEInvoiceCreditNote(@Ctx() ctx: RequestContext, @Args() args: { input: ManualCreditNoteInput }) {
    const note = await this.invoices.createCreditNote(ctx, args.input);
    return this.invoices.findOne(ctx, note.id);
  }

  @Mutation()
  @Allow(eInvoicePermission.Create)
  async cancelAndReissueEInvoice(@Ctx() ctx: RequestContext, @Args() args: { invoiceId: ID }) {
    const invoice = await this.invoices.cancelAndReissue(ctx, args.invoiceId);
    return this.invoices.findOne(ctx, invoice.id);
  }

  @Mutation()
  @Allow(eInvoicePermission.Update)
  async voidEInvoice(@Ctx() ctx: RequestContext, @Args() args: { id: ID; reason: string }) {
    const invoice = await this.invoices.void(ctx, args.id, args.reason);
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
  constructor(
    private invoices: InvoiceService,
    private orderService: OrderService,
  ) {}

  @ResolveField()
  async order(@Ctx() ctx: RequestContext, @Parent() invoice: EInvoice) {
    return (await this.orderService.findOne(ctx, invoice.orderId)) ?? invoice.order;
  }

  @ResolveField()
  async orderCode(@Ctx() ctx: RequestContext, @Parent() invoice: EInvoice) {
    if (invoice.order?.code) return invoice.order.code;
    return (await this.orderService.findOne(ctx, invoice.orderId, []))?.code;
  }

  @ResolveField()
  correctedInvoice(@Ctx() ctx: RequestContext, @Parent() invoice: EInvoice) {
    return invoice.correctedInvoiceId ? this.invoices.findOne(ctx, invoice.correctedInvoiceId) : null;
  }

  @ResolveField()
  creditNotes(@Ctx() ctx: RequestContext, @Parent() invoice: EInvoice) {
    return invoice.type === 'invoice' ? this.invoices.creditNotesOf(ctx, invoice.id) : [];
  }

  @ResolveField()
  remainingAmount(@Ctx() ctx: RequestContext, @Parent() invoice: EInvoice) {
    return this.invoices.remainingAmount(ctx, invoice);
  }
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
