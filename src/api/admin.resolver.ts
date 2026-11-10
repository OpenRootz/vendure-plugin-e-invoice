import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ForbiddenError, ID, ListQueryOptions, Order, OrderService, Permission, RequestContext, UserInputError } from '@vendure/core';

import { eInvoicePermission } from '../constants';
import { EInvoiceFormat, LayoutPreset, layoutPreset, SampleKind, v1Fields } from '../core';
import { LayoutSettings } from '../entities';
import { EInvoice, EInvoiceFile } from '../entities';
import { ChannelSettingsService, UpdateChannelSettingsInput } from '../services/channel-settings.service';
import { DownloadLinkService, MAX_ZIP_INVOICES } from '../services/download-link.service';
import { InvoiceService, ManualCreditNoteInput } from '../services/invoice.service';
import { LayoutInput, LayoutPreviewInput, LayoutPreviewService } from '../services/layout-preview.service';

export const formatEnum = (f: EInvoiceFormat) => f.toUpperCase().replace(/-/g, '_');
export const formatFromEnum = (f: string) => f.toLowerCase().replace(/_/g, '-') as EInvoiceFormat;

type Filter = Record<string, unknown> & { _and?: Filter[]; _or?: Filter[] };

/** `ReadEInvoice` alone does not grant access to orders: everything that reads an order also needs `ReadOrder`. */
const canReadOrders = (ctx: RequestContext) => ctx.userHasPermissions([Permission.ReadOrder]);

function assertCanReadOrders(ctx: RequestContext) {
  if (!canReadOrders(ctx)) throw new ForbiddenError();
}

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
    private links: DownloadLinkService,
    private layoutPreview: LayoutPreviewService,
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
    assertCanReadOrders(ctx);
    return this.invoices.preview(ctx, args.orderId);
  }

  @Query()
  @Allow(eInvoicePermission.Read)
  eInvoiceLayoutPreview(@Ctx() ctx: RequestContext, @Args() args: { input: Omit<LayoutPreviewInput, 'sample'> & { sample?: string | null } }) {
    const { sample, ...input } = args.input;
    if (input.orderId) assertCanReadOrders(ctx);
    return this.layoutPreview.preview(ctx, { ...input, sample: sample ? (sample.toLowerCase().replace(/_/g, '-') as SampleKind) : undefined });
  }

  @Query()
  @Allow(eInvoicePermission.Read)
  eInvoiceDefaultLayout(@Args() args: { preset?: string | null }) {
    const presets: Record<string, LayoutPreset> = { DEFAULT: 'default', DIN_5008_A: 'din5008A', DIN_5008_B: 'din5008B', MINIMAL: 'minimal' };
    return layoutPreset(presets[args.preset ?? 'DEFAULT'] ?? 'default');
  }

  @Query()
  @Allow(eInvoicePermission.Read)
  eInvoiceLayoutFonts() {
    return this.layoutPreview.fontNames();
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
  @Allow(eInvoicePermission.Read)
  async createEInvoiceGuestLink(@Ctx() ctx: RequestContext, @Args() args: { invoiceId: ID; format?: string }) {
    const invoice = await this.invoices.findOne(ctx, args.invoiceId);
    if (invoice?.status !== 'ISSUED') throw new UserInputError(`E-invoice ${args.invoiceId} is not issued`);
    const format = args.format ? formatFromEnum(args.format) : undefined;
    if (format && !invoice.files.some((f) => f.format === format)) {
      throw new UserInputError(`E-invoice ${invoice.number} has no ${args.format} file`);
    }
    return this.links.fileLink(ctx, invoice, format, 'guest');
  }

  @Mutation()
  @Allow(eInvoicePermission.Read)
  async createEInvoiceZipLink(@Ctx() ctx: RequestContext, @Args() args: { ids: ID[] }) {
    if (!args.ids.length) throw new UserInputError('No e-invoices selected');
    if (args.ids.length > MAX_ZIP_INVOICES) throw new UserInputError(`At most ${MAX_ZIP_INVOICES} e-invoices can be downloaded at once`);
    for (const id of args.ids) {
      const invoice = await this.invoices.findOne(ctx, id);
      if (invoice?.status !== 'ISSUED') throw new UserInputError(`E-invoice ${invoice?.number ?? id} is not issued`);
    }
    return this.links.zipLink(ctx, args.ids, 'admin');
  }

  @Mutation()
  @Allow(eInvoicePermission.Update)
  async voidEInvoice(@Ctx() ctx: RequestContext, @Args() args: { id: ID; reason: string }) {
    const invoice = await this.invoices.void(ctx, args.id, args.reason);
    return this.invoices.findOne(ctx, invoice.id);
  }

  @Mutation()
  @Allow(eInvoicePermission.Update)
  async updateEInvoiceChannelSettings(@Ctx() ctx: RequestContext, @Args() args: { input: UpdateChannelSettingsInput & { layout?: LayoutInput | null } }) {
    const { layout, ...input } = args.input;
    const prepared = layout ? await this.layoutPreview.prepareLayout(ctx, layout, input.seller, input.payment) : undefined;
    return this.settings.update(ctx, { ...input, ...(prepared ? { layout: prepared } : {}) });
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
    if (!canReadOrders(ctx)) return null;
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
  async creditable(@Ctx() ctx: RequestContext, @Parent() invoice: EInvoice) {
    const summary = await this.invoices.creditable(ctx, invoice);
    return (
      summary && {
        ...summary,
        lines: summary.lines.map((l) => ({
          orderLineId: l.orderLineId ?? null,
          name: l.name,
          sku: l.sellerItemId ?? null,
          invoicedQuantity: Math.round(Number(l.invoicedQuantity)),
          remainingQuantity: Math.floor(Number(l.remainingQuantity)),
          remainingGross: l.remainingGross,
        })),
      }
    );
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

  @ResolveField()
  validation(@Parent() invoice: EInvoice) {
    const v = invoice.validation;
    return v && { ...v, results: v.results.map((r) => ({ ...r, format: formatEnum(r.format) })) };
  }
}

/** Shared by the Admin and the Shop API. */
@Resolver('EInvoiceFile')
export class EInvoiceFileResolver {
  constructor(private links: DownloadLinkService) {}

  @ResolveField()
  format(@Parent() file: EInvoiceFile) {
    return formatEnum(file.format);
  }

  @ResolveField()
  downloadUrl(@Ctx() ctx: RequestContext, @Parent() file: EInvoiceFile) {
    return this.links.fileLink(ctx, { id: file.invoiceId }, file.format, ctx.apiType === 'shop' ? 'owner' : 'admin');
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

/** The stored layout is the v2 document; the v1 fields are derived from it. */
@Resolver('EInvoiceLayout')
export class EInvoiceLayoutResolver {
  @ResolveField()
  document(@Parent() layout: LayoutSettings) {
    const { logoAssetId: _logo, ...document } = layout;
    return document;
  }

  @ResolveField()
  accentColor(@Parent() layout: LayoutSettings) {
    return v1Fields(layout).accentColor;
  }

  @ResolveField()
  introText(@Parent() layout: LayoutSettings) {
    return v1Fields(layout).introText || null;
  }

  @ResolveField()
  closingText(@Parent() layout: LayoutSettings) {
    return v1Fields(layout).closingText || null;
  }

  @ResolveField()
  footerText(@Parent() layout: LayoutSettings) {
    return v1Fields(layout).footerText || null;
  }
}
