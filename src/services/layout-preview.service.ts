import { Inject, Injectable } from '@nestjs/common';
import { ID, Order, RequestContext, TransactionalConnection, UserInputError } from '@vendure/core';

import { PLUGIN_INIT_OPTIONS } from '../constants';
import { calculate, checkModel, EInvoiceModel, pdfLabels, SampleKind, sampleModel } from '../core';
import { LayoutSettings, PaymentSettings, SellerSettings } from '../entities';
import { OrderModelMapper } from '../mapping/order-model.mapper';
import { ResolvedEInvoicePluginOptions } from '../options';
import { ChannelSettingsSellerStrategy, sellerFromSettings } from '../strategies/seller-data-strategy';
import { SellerData } from '../strategies/types';

import { ChannelSettingsService, compact, SetupIssue } from './channel-settings.service';
import { InvoiceRenderService } from './invoice-render.service';

export interface LayoutPreviewInput {
  /** Unsaved layout; omitted = saved layout */
  layout?: LayoutSettings | null;
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
    const layout = input.layout ? compact(input.layout) : saved.layout;
    await this.settings.assertValidLayout(ctx, layout);
    const sellerSettings = input.seller ? compact(input.seller) : saved.seller;
    const paymentSettings = input.payment ? compact(input.payment) : saved.payment;
    const issues: SetupIssue[] = [];

    let model: EInvoiceModel;
    if (input.orderId) {
      const order = await this.mapper.loadOrder(ctx, input.orderId);
      if (!order) throw new UserInputError(`Order ${input.orderId} not found`);
      const mapped = await this.mapper.toModel(ctx, order);
      if (!mapped) {
        return { pdf: null, pageCount: 0, issues: [{ code: 'SELLER_INCOMPLETE', message: 'E-invoicing is not set up for this channel (no seller data)' }] };
      }
      model = mapped.model;
      if (input.seller && this.defaultSellerStrategy()) model.seller = sellerFromSettings(sellerSettings);
      model.totals = calculate(model, { expectedTotalWithTax: order.totalWithTax, fallbackThreshold: this.options.roundingFallbackThreshold });
    } else {
      const language = input.language || ctx.channel.defaultLanguageCode;
      const seller = await this.sampleSeller(ctx, sellerSettings, paymentSettings, issues);
      model = sampleModel(input.sample ?? 'b2b-net', {
        seller: seller.seller,
        bank: seller.bank,
        paymentTerms: seller.paymentTerms,
        paymentTermDays: seller.paymentTermDays,
        number: pdfLabels(language, this.options.pdf.translations).draft,
        language,
        currencyCode: ctx.channel.defaultCurrencyCode,
        issueDate: this.mapper.today(),
      });
    }
    if (input.language) model.language = input.language;
    model.number = pdfLabels(model.language, this.options.pdf.translations).draft;
    if (model.totals && model.totals.duePayable > 0) model.payment.reference = model.number;
    issues.push(...checkModel(model, ['zugferd']));

    try {
      const rendered = await this.limited(() => this.renderer.renderPdfDetailed(ctx, model, { layout, enforceLogoLimit: true }));
      return {
        pdf: `data:application/pdf;base64,${rendered.pdf.toString('base64')}`,
        pageCount: rendered.pageCount,
        issues: [...issues, ...rendered.issues],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { pdf: null, pageCount: 0, issues: [...issues, { code: 'RENDER_FAILED', message }] };
    }
  }

  private defaultSellerStrategy() {
    return this.options.sellerStrategy instanceof ChannelSettingsSellerStrategy;
  }

  /**
   * Seller of the sample invoice: the (draft) settings with the default seller strategy. A custom strategy needs an
   * order, so the latest order is used if there is one; otherwise the settings, with an info issue.
   */
  private async sampleSeller(ctx: RequestContext, seller: SellerSettings, payment: PaymentSettings, issues: SetupIssue[]): Promise<SellerData> {
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
