import { Inject, Injectable } from '@nestjs/common';
import { Asset, ConfigService, ID, RequestContext, TaxRate, TransactionalConnection, UserInputError } from '@vendure/core';

import { PLUGIN_INIT_OPTIONS } from '../constants';
import { checkSeller, isLayoutV2, layoutFromV1, PdfLayout } from '../core';
import { EInvoiceChannelSettings, LayoutSettings, LegacyLayoutSettings, PaymentSettings, SellerSettings } from '../entities';
import { ResolvedEInvoicePluginOptions } from '../options';
import { ChannelSettingsSellerStrategy, sellerFromSettings } from '../strategies/seller-data-strategy';

import { encodeEntityId, isStorableId } from './entity-ids';

export interface UpdateChannelSettingsInput {
  enabled?: boolean;
  autoIssue?: boolean;
  seller?: SellerSettings;
  payment?: PaymentSettings;
  layout?: LayoutSettings | LegacyLayoutSettings;
}

/** A problem reported through the API (setup status, preview). `path` points to where it can be fixed. */
export interface SetupIssue {
  code: string;
  message: string;
  /** e.g. `seller.vatId` or `taxRate:12` */
  path?: string;
}

/** Longest text field of a layout (intro, closing and footer text, custom text blocks). */
export const MAX_LAYOUT_TEXT = 2000;
/** Logos above this size are rejected (also enforced by the preview). */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const EXEMPT_CATEGORIES = ['E', 'AE', 'K', 'G', 'O'];
const ZERO_RATE_CATEGORIES = ['Z', 'E', 'AE', 'K', 'G', 'O'];

/**
 * The e-invoicing settings of a channel ({@link EInvoiceChannelSettings}): seller data, payment terms, PDF layout,
 * enabled / auto-issue, and the setup status.
 *
 * @category Services
 */
@Injectable()
export class ChannelSettingsService {
  /** @internal */
  constructor(
    @Inject(PLUGIN_INIT_OPTIONS) private options: ResolvedEInvoicePluginOptions,
    private connection: TransactionalConnection,
    private configService: ConfigService,
  ) {}

  /** Settings of the current channel; an unsaved default (disabled) when none exist yet. v1 layouts are converted. */
  async get(ctx: RequestContext): Promise<EInvoiceChannelSettings> {
    const existing = await this.connection.getRepository(ctx, EInvoiceChannelSettings).findOne({ where: { channelId: ctx.channelId } });
    const settings =
      existing ??
      new EInvoiceChannelSettings({
        channelId: ctx.channelId,
        enabled: false,
        autoIssue: true,
        seller: {},
        payment: {},
        layout: undefined,
      });
    settings.layout = migrateLayout(settings.layout);
    return settings;
  }

  /**
   * Updates the settings of the current channel. Only the given parts are replaced; a layout is validated with
   * {@link ChannelSettingsService.assertValidLayout}.
   */
  async update(ctx: RequestContext, input: UpdateChannelSettingsInput): Promise<EInvoiceChannelSettings> {
    const settings = await this.get(ctx);
    if (input.enabled !== undefined && input.enabled !== null) settings.enabled = input.enabled;
    if (input.autoIssue !== undefined && input.autoIssue !== null) settings.autoIssue = input.autoIssue;
    if (input.seller) settings.seller = compact(input.seller);
    if (input.payment) settings.payment = compact(input.payment);
    if (input.layout) {
      // The resolver validates the layout completely (LayoutPreviewService.prepareLayout); this is the minimum
      const layout = migrateLayout(input.layout);
      await this.assertValidLayout(ctx, layout);
      settings.layout = layout;
    }
    return this.connection.getRepository(ctx, EInvoiceChannelSettings).save(settings);
  }

  /** Rejects layouts with oversized texts or logos (`UserInputError`). Used on save and by the preview. */
  async assertValidLayout(ctx: RequestContext, layout: LayoutSettings | LegacyLayoutSettings): Promise<void> {
    const problems = isLayoutV2(layout) ? [] : layoutTextProblems(layout);
    const assets = [
      ...(layout.logoAssetId ? [{ id: layout.logoAssetId, what: 'The logo' }] : []),
      ...(isLayoutV2(layout) ? layout.blocks : [])
        .filter((b) => b.type === 'image' && b.props?.assetId !== undefined)
        .map((b) => ({ id: b.props!.assetId as ID, what: `The image of block ${b.key}` })),
    ];
    for (const { id, what } of assets) {
      // Unknown IDs render without the image (LOGO_NOT_FOUND); malformed ones must not reach the database
      if (!isStorableId(this.configService, id)) continue;
      const asset = await this.connection.getRepository(ctx, Asset).findOne({ where: { id, channels: { id: ctx.channelId } } });
      if (asset && asset.fileSize > MAX_LOGO_BYTES) problems.push(`${what} is larger than ${MAX_LOGO_BYTES / 1024 / 1024} MB`);
    }
    if (problems.length) throw new UserInputError(`Invalid layout: ${problems.join('; ')}`);
  }

  /**
   * What is missing before invoices can be issued in the current channel. The checks that need an order
   * (buyer data, totals) run when an invoice is created.
   */
  async setupStatus(ctx: RequestContext): Promise<SetupIssue[]> {
    const issues: SetupIssue[] = [];
    const settings = await this.get(ctx);
    if (!settings.enabled) {
      issues.push({ code: 'NOT_ENABLED', message: 'E-invoicing is not enabled for this channel', path: 'enabled' });
    }
    // Custom seller strategies get their data elsewhere; only the default reads the settings
    if (this.options.sellerStrategy instanceof ChannelSettingsSellerStrategy) {
      issues.push(...checkSeller(sellerFromSettings(settings.seller)));
    }
    if (settings.payment.termDays && !settings.seller.bank?.iban) {
      issues.push({
        code: 'PAYMENT_ACCOUNT_MISSING',
        message: 'Payment terms are set, but no bank account: invoices with an amount due cannot name where to pay',
        path: 'seller.bank',
      });
    }

    const taxRates = await this.connection.getRepository(ctx, TaxRate).find({ where: { enabled: true }, order: { id: 'ASC' } });
    for (const rate of taxRates) {
      const code = rate.customFields?.eInvoiceCategoryCode || undefined;
      // The dashboard links to the tax rate, so the path carries the ID as the API exposes it
      const path = `taxRate:${encodeEntityId(this.configService, rate.id)}`;
      const zero = Number(rate.value) === 0;
      if (zero && (!code || code === 'S')) {
        issues.push({
          code: 'TAX_CATEGORY_MISSING',
          message: `Tax rate "${rate.name}" is 0 % and needs a VAT category (e.g. Z, E, AE, K, G)`,
          path,
        });
      } else if (code && ZERO_RATE_CATEGORIES.includes(code) && !zero) {
        issues.push({
          code: 'INVALID_RATE_FOR_CATEGORY',
          message: `Tax rate "${rate.name}" has VAT category ${code}, which requires 0 %`,
          path,
        });
      }
      if (
        code &&
        EXEMPT_CATEGORIES.includes(code) &&
        !rate.customFields?.eInvoiceExemptionReason &&
        !rate.customFields?.eInvoiceExemptionReasonCode
      ) {
        issues.push({
          code: 'EXEMPTION_REASON_REQUIRED',
          message: `Tax rate "${rate.name}" has VAT category ${code} and needs an exemption reason or VATEX code`,
          path,
        });
      }
    }
    return issues;
  }
}

/** v1 layouts (and none) become the v2 default layout with the v1 values. */
export function migrateLayout(layout: LayoutSettings | LegacyLayoutSettings | undefined | null): LayoutSettings {
  if (isLayoutV2(layout)) return layout as LayoutSettings;
  const { logoAssetId, ...v1 } = (layout ?? {}) as LegacyLayoutSettings;
  return { ...layoutFromV1(v1), ...(logoAssetId ? { logoAssetId } : {}) };
}

/** Text fields longer than {@link MAX_LAYOUT_TEXT}. */
export function layoutTextProblems(layout: PdfLayout): string[] {
  return (['introText', 'closingText', 'footerText'] as const)
    .filter((k) => (layout[k]?.length ?? 0) > MAX_LAYOUT_TEXT)
    .map((k) => `${k} is longer than ${MAX_LAYOUT_TEXT} characters`);
}

/** Drops null, undefined and empty-string values (GraphQL inputs send `null` for cleared fields). */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === '') continue;
      const c = compact(v);
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out as T;
  }
  return value;
}
