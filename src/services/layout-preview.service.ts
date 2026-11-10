import { Inject, Injectable } from '@nestjs/common';
import { ID, Order, RequestContext, TransactionalConnection, UserInputError } from '@vendure/core';

import { PLUGIN_INIT_OPTIONS } from '../constants';
import {
  BlockBox,
  calculate,
  checkLayout,
  checkModel,
  defaultFonts,
  defaultLayout,
  EInvoiceModel,
  layoutDocument,
  LayoutIssue,
  parseLayout,
  patchLayout,
  PdfLayout,
  pdfLabels,
  SampleKind,
  sampleModel,
} from '../core';
import { LayoutSettings, PaymentSettings, SellerSettings } from '../entities';
import { OrderModelMapper } from '../mapping/order-model.mapper';
import { ResolvedEInvoicePluginOptions } from '../options';
import { ChannelSettingsSellerStrategy, sellerFromSettings } from '../strategies/seller-data-strategy';
import { SellerData } from '../strategies/types';

import { ChannelSettingsService, compact, SetupIssue } from './channel-settings.service';
import { InvoiceRenderService } from './invoice-render.service';

/** The layout as the API takes it: the document plus the v1 fields as shortcuts that patch it. */
export interface LayoutInput extends PdfLayout {
  logoAssetId?: ID | null;
  /** Layout v2; omitted = the default layout */
  document?: unknown;
}

export interface LayoutPreviewInput {
  /** Unsaved layout; omitted = saved layout */
  layout?: LayoutInput | null;
  /** Unsaved seller data (settings page); omitted = saved */
  seller?: SellerSettings | null;
  payment?: PaymentSettings | null;
  /** Render this order instead of sample data */
  orderId?: ID | null;
  sample?: SampleKind | null;
  language?: string | null;
}

export interface LayoutPreview {
  /** Data URL; null if rendering failed */
  pdf: string | null;
  pageCount: number;
  issues: SetupIssue[];
  /** Where every block ended up (0.1 mm) */
  blocks: BlockBox[];
  /** Problems of the layout itself; errors block saving */
  layoutIssues: LayoutIssue[];
}

/** Renders at most this many previews at the same time per process; the rest wait. */
const MAX_CONCURRENT_RENDERS = 2;

/**
 * Live layout preview (settings and layout pages): the real ZUGFeRD pipeline with a draft layout and sample data
 * or an order. Nothing is stored and no number is used. The validator does not run (too slow for typing).
 */
@Injectable()
export class LayoutPreviewService {
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions,
    private connection: TransactionalConnection,
    private mapper: OrderModelMapper,
    private settings: ChannelSettingsService,
    private renderer: InvoiceRenderService,
  ) {}

  async preview(ctx: RequestContext, input: LayoutPreviewInput): Promise<LayoutPreview> {
    const saved = await this.settings.get(ctx);
    const sellerSettings = input.seller ? compact(input.seller) : saved.seller;
    const paymentSettings = input.payment ? compact(input.payment) : saved.payment;
    const issues: SetupIssue[] = [];
    const empty = { pdf: null, pageCount: 0, blocks: [] };

    let layout: LayoutSettings = saved.layout;
    if (input.layout) {
      const resolved = resolveLayoutInput(input.layout);
      if (!resolved.layout) return { ...empty, issues, layoutIssues: resolved.issues };
      layout = resolved.layout;
    }
    // Oversized logos/images are not rejected here: the renderer skips them and reports LOGO_TOO_LARGE

    let model: EInvoiceModel;
    if (input.orderId) {
      const order = await this.mapper.loadOrder(ctx, input.orderId);
      if (!order) throw new UserInputError(`Order ${input.orderId} not found`);
      const mapped = await this.mapper.toModel(ctx, order);
      if (!mapped) {
        return {
          ...empty,
          layoutIssues: [],
          issues: [{ code: 'SELLER_INCOMPLETE', message: 'E-invoicing is not set up for this channel (no seller data)' }],
        };
      }
      model = mapped.model;
      if (input.seller && this.defaultSellerStrategy()) model.seller = sellerFromSettings(sellerSettings);
      model.totals = calculate(model, {
        expectedTotalWithTax: order.totalWithTax,
        fallbackThreshold: this.options.roundingFallbackThreshold,
      });
    } else {
      const seller = await this.sampleSeller(ctx, sellerSettings, paymentSettings, issues);
      model = this.sample(ctx, input.sample ?? 'b2b-net', seller, input.language);
    }
    if (input.language) model.language = input.language;
    model.number = pdfLabels(model.language, this.options.pdf.translations).draft;
    if (model.totals && model.totals.duePayable > 0) model.payment.reference = model.number;
    issues.push(...checkModel(model, ['zugferd']));

    try {
      const result = await this.limited(async () => {
        const rendered = await this.renderer.renderPdfDetailed(ctx, model, { layout, enforceLogoLimit: true });
        const saveIssues = await this.checkLayout(ctx, layout, sellerSettings, paymentSettings);
        return { rendered, saveIssues };
      });
      const { rendered, saveIssues } = result;
      const current = rendered.layout
        ? checkLayout(layout, rendered.layout.measurement, model, { fonts: this.fontNames() }).filter((i) => i.level === 'warning')
        : [];
      return {
        pdf: `data:application/pdf;base64,${rendered.pdf.toString('base64')}`,
        pageCount: rendered.pageCount,
        issues: [...issues, ...rendered.issues],
        blocks: rendered.layout?.measurement.boxes ?? [],
        layoutIssues: dedupe([
          ...saveIssues.filter((i) => i.level === 'error' || i.code === 'FONT_REDUCED'),
          ...current,
          ...(rendered.layout?.issues ?? []),
        ]),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ...empty, issues: [...issues, { code: 'RENDER_FAILED', message }], layoutIssues: [] };
    }
  }

  /**
   * Resolves the layout input and validates it completely: structure, texts and images, and the layout checks
   * against the worst-case sample (content coverage, clipping, …). Throws a `UserInputError` listing the errors.
   */
  async prepareLayout(
    ctx: RequestContext,
    input: LayoutInput,
    seller?: SellerSettings | null,
    payment?: PaymentSettings | null,
  ): Promise<LayoutSettings> {
    const resolved = resolveLayoutInput(input);
    const fail = (issues: LayoutIssue[]) => {
      throw new UserInputError(`Invalid layout: ${issues.map((i) => i.message).join('; ')}`);
    };
    if (!resolved.layout) return fail(resolved.issues);
    const layout = resolved.layout;
    await this.settings.assertValidLayout(ctx, layout);
    const saved = await this.settings.get(ctx);
    const errors = (
      await this.limited(() =>
        this.checkLayout(ctx, layout, seller ? compact(seller) : saved.seller, payment ? compact(payment) : saved.payment),
      )
    ).filter((i) => i.level === 'error');
    if (errors.length) fail(errors);
    return layout;
  }

  /**
   * The layout checks with the worst-case sample. Measured like at render time: a fixed block whose content does
   * not fit gets a smaller font (down to 6 pt, reported as FONT_REDUCED); only what still does not fit is an error.
   */
  private async checkLayout(
    ctx: RequestContext,
    layout: LayoutSettings,
    seller: SellerSettings,
    payment: PaymentSettings,
  ): Promise<LayoutIssue[]> {
    const fonts = this.options.pdf.fonts ?? defaultFonts();
    const fontNames = Object.keys(fonts);
    // Without the font nothing can be laid out; report it (static check) and measure with the default font
    const unknownFont = !!layout.theme.font && !fontNames.includes(layout.theme.font);
    const measured: LayoutSettings = unknownFont ? { ...layout, theme: { ...layout.theme, font: undefined } } : layout;
    const data = await this.sampleSeller(ctx, seller, payment, []);
    const issues: LayoutIssue[] = unknownFont
      ? checkLayout(layout, undefined, undefined, { fonts: fontNames }).filter((i) => i.code === 'UNKNOWN_FONT')
      : [];
    // Invoices can be issued in any of these languages; labels and sample texts differ in length
    for (const language of this.checkLanguages(ctx)) {
      const model = this.sample(ctx, 'worst-case', data, language);
      // Oversized images are skipped like in the preview (saving rejects them separately)
      const input = await this.renderer.templateInput(ctx, model, measured, []);
      const result = await layoutDocument(measured, input, fonts, { fit: true });
      const reduced = result.issues
        .filter((i) => i.code === 'FONT_REDUCED')
        .map((i) => ({ ...i, message: `${i.message} (longest sample invoice, ${language})` }));
      issues.push(...checkLayout(measured, result.measurement, undefined, { fonts: fontNames }), ...reduced);
    }
    // One issue per block and code (e.g. the smallest reduced font is reported by the first language that needs it)
    return issues.filter(
      (x, i) => issues.findIndex((y) => y.code === x.code && (x.blockKey ? y.blockKey === x.blockKey : y.message === x.message)) === i,
    );
  }

  /** The channel language plus German and English (the built-in labels). */
  private checkLanguages(ctx: RequestContext): string[] {
    return [...new Set([ctx.channel.defaultLanguageCode.split(/[-_]/)[0].toLowerCase(), 'de', 'en'])];
  }

  /** Font families the PDF can use (`pdf.fonts`; the first is the default). */
  fontNames(): string[] {
    return Object.keys(this.options.pdf.fonts ?? defaultFonts());
  }

  private sample(ctx: RequestContext, kind: SampleKind, seller: SellerData, language?: string | null): EInvoiceModel {
    const lang = language || ctx.channel.defaultLanguageCode;
    return sampleModel(kind, {
      seller: seller.seller,
      bank: seller.bank,
      paymentTerms: seller.paymentTerms,
      paymentTermDays: seller.paymentTermDays,
      number: pdfLabels(lang, this.options.pdf.translations).draft,
      language: lang,
      currencyCode: ctx.channel.defaultCurrencyCode,
      issueDate: this.mapper.today(),
    });
  }

  private defaultSellerStrategy() {
    return this.options.sellerStrategy instanceof ChannelSettingsSellerStrategy;
  }

  /**
   * Seller of the sample invoice: the (draft) settings with the default seller strategy. A custom strategy needs an
   * order, so the latest order is used if there is one; otherwise the settings, with an info issue.
   */
  private async sampleSeller(
    ctx: RequestContext,
    seller: SellerSettings,
    payment: PaymentSettings,
    issues: SetupIssue[],
  ): Promise<SellerData> {
    const fromSettings: SellerData = {
      seller: sellerFromSettings(seller),
      bank: seller.bank?.iban ? seller.bank : undefined,
      paymentTerms: payment.termsText,
      paymentTermDays: payment.termDays,
    };
    if (this.defaultSellerStrategy()) return fromSettings;
    const latest = await this.connection.getRepository(ctx, Order).findOne({
      where: { active: false, channels: { id: ctx.channelId } },
      order: { orderPlacedAt: 'DESC' },
    });
    const data = latest ? await this.options.sellerStrategy.getSeller(ctx, latest) : undefined;
    if (data) return data;
    issues.push({
      code: 'SAMPLE_SELLER_FROM_SETTINGS',
      message: 'The seller data is provided by a custom strategy; the sample uses the seller data from the settings',
    });
    return fromSettings;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    // A finishing render hands its slot directly to the next waiting one
    if (this.running >= MAX_CONCURRENT_RENDERS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

const blank = (v: unknown) => v === undefined || v === null;

/**
 * The stored layout for an API input: the document (validated structurally) or the default layout, patched with
 * the v1 fields that are set. Returns the structural errors instead of a layout if the document is invalid.
 */
export function resolveLayoutInput(input: LayoutInput): { layout?: LayoutSettings; issues: LayoutIssue[] } {
  let base = defaultLayout();
  if (!blank(input.document)) {
    const parsed = parseLayout(input.document);
    if (!parsed.layout) return { issues: parsed.issues };
    const { logoAssetId: _ignored, ...doc } = parsed.layout as LayoutSettings;
    base = doc;
  }
  const v1: PdfLayout = {};
  for (const key of ['accentColor', 'introText', 'closingText', 'footerText'] as const) {
    const value = input[key];
    if (!blank(value)) v1[key] = value as string;
  }
  const tooLong = Object.entries(v1).filter(([, v]) => (v?.length ?? 0) > 2000);
  if (tooLong.length) {
    return {
      issues: tooLong.map(([k]) => ({ level: 'error' as const, code: 'TEXT_TOO_LONG', message: `${k} is longer than 2000 characters` })),
    };
  }
  const layout: LayoutSettings = Object.keys(v1).length ? patchLayout(base, v1) : base;
  if (!blank(input.logoAssetId) && input.logoAssetId !== '') layout.logoAssetId = input.logoAssetId as ID;
  return { layout, issues: [] };
}

function dedupe(issues: LayoutIssue[]): LayoutIssue[] {
  return issues.filter((x, i) => issues.findIndex((y) => y.code === x.code && y.message === x.message) === i);
}
