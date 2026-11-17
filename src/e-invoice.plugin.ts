import { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Injector, Logger, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { EInvoiceDownloadController } from './api/download.controller';
import { adminApiExtensions, shopApiExtensions } from './api/schema';
import { EInvoiceShopDeliveryResolver, EInvoiceShopEntityResolver, EInvoiceShopOrderResolver } from './api/shop.resolver';
import {
  EInvoiceAdminResolver,
  EInvoiceChannelSettingsResolver,
  EInvoiceDeliveryResolver,
  EInvoiceEntityResolver,
  EInvoiceFileResolver,
  EInvoiceLayoutResolver,
  EInvoiceOrderResolver,
} from './api/admin.resolver';
import { eInvoicePermissionDefinitions, loggerCtx, PLUGIN_INIT_OPTIONS } from './constants';
import { customFields } from './custom-fields';
import {
  adaptJsonColumns,
  defineBlobColumn,
  EInvoice,
  EInvoiceBlob,
  EInvoiceChannelSettings,
  EInvoiceDelivery,
  EInvoiceFile,
  EInvoiceSequence,
} from './entities';
import { OrderModelMapper } from './mapping/order-model.mapper';
import { EInvoicePluginOptions, resolveOptions, ResolvedEInvoicePluginOptions } from './options';
import { ChannelSettingsService } from './services/channel-settings.service';
import { CreditNoteService } from './services/credit-note.service';
import { EInvoiceDeliveryService } from './services/delivery.service';
import { DownloadLinkService } from './services/download-link.service';
import { NoopValidator } from './strategies/validator';
import { InvoiceNumberService } from './services/invoice-number.service';
import { InvoiceRenderService } from './services/invoice-render.service';
import { InvoiceService } from './services/invoice.service';
import { LayoutPreviewService } from './services/layout-preview.service';

/**
 * EN 16931 e-invoicing for Vendure: issues invoices and credit notes for orders as ZUGFeRD / Factur-X (PDF/A-3
 * with embedded CII XML) and XRechnung (CII or UBL), with gap-free numbering, immutable snapshots, signed download
 * links and a dashboard extension.
 *
 * Adds the entities `EInvoice`, `EInvoiceFile`, `EInvoiceSequence`, `EInvoiceChannelSettings`, `EInvoiceBlob` and
 * `EInvoiceDelivery`,
 * custom fields on Customer, Order, TaxRate and PaymentMethod, the permissions `CreateEInvoice`, `ReadEInvoice`
 * and `UpdateEInvoice`, Admin and Shop API extensions and the download route `/e-invoice`.
 *
 * Configure it with {@link EInvoicePlugin.init}.
 *
 * @category Plugin
 */
@VendurePlugin({
  imports: [PluginCommonModule],
  entities: [EInvoice, EInvoiceFile, EInvoiceSequence, EInvoiceChannelSettings, EInvoiceBlob, EInvoiceDelivery],
  providers: [
    { provide: PLUGIN_INIT_OPTIONS, useFactory: () => EInvoicePlugin.options },
    OrderModelMapper,
    ChannelSettingsService,
    InvoiceNumberService,
    InvoiceRenderService,
    CreditNoteService,
    InvoiceService,
    DownloadLinkService,
    LayoutPreviewService,
    EInvoiceDeliveryService,
  ],
  controllers: [EInvoiceDownloadController],
  adminApiExtensions: {
    schema: adminApiExtensions,
    resolvers: [
      EInvoiceAdminResolver,
      EInvoiceEntityResolver,
      EInvoiceFileResolver,
      EInvoiceOrderResolver,
      EInvoiceLayoutResolver,
      EInvoiceDeliveryResolver,
      EInvoiceChannelSettingsResolver,
    ],
  },
  shopApiExtensions: {
    schema: shopApiExtensions,
    resolvers: [EInvoiceShopOrderResolver, EInvoiceShopEntityResolver, EInvoiceFileResolver, EInvoiceShopDeliveryResolver],
  },
  configuration: (config) => {
    const options = EInvoicePlugin.options;
    defineBlobColumn(config.dbConnectionOptions.type);
    adaptJsonColumns(config.dbConnectionOptions.type);
    config.authOptions.customPermissions.push(...eInvoicePermissionDefinitions);
    const fields = customFields({ exposeBuyerFieldsInShop: options.exposeBuyerFieldsInShop });
    config.customFields.Customer.push(...fields.Customer);
    config.customFields.Order.push(...fields.Order);
    config.customFields.TaxRate.push(...fields.TaxRate);
    config.customFields.PaymentMethod.push(...fields.PaymentMethod);
    return config;
  },
  // Relative to this file: src/ while developing, dist/ when installed; both resolve to the package's dashboard/
  dashboard: '../dashboard/index.tsx',
  compatibility: '^3.8.0',
})
export class EInvoicePlugin implements OnApplicationBootstrap, OnApplicationShutdown {
  /** @internal */
  static options: ResolvedEInvoicePluginOptions;

  /** @internal */
  constructor(private moduleRef: ModuleRef) {}

  /**
   * Configures the plugin. Only `secret` is required; everything else has a default.
   *
   * @example
   * ```ts
   * // vendure-config.ts
   * import { EInvoicePlugin } from '@openrootz/vendure-plugin-e-invoice';
   *
   * export const config: VendureConfig = {
   *   // ...
   *   plugins: [
   *     EInvoicePlugin.init({
   *       // Signs download links. At least 32 characters; keep it secret and stable.
   *       secret: process.env.E_INVOICE_SECRET!,
   *     }),
   *   ],
   * };
   * ```
   */
  static init(options: EInvoicePluginOptions): Type<EInvoicePlugin> {
    this.options = resolveOptions(options);
    return EInvoicePlugin;
  }

  /** @internal */
  async onApplicationBootstrap() {
    const { validation } = EInvoicePlugin.options;
    if (validation.mode !== 'off' && validation.validator instanceof NoopValidator) {
      Logger.warn(`validation.mode is '${validation.mode}', but no validator is configured (e.g. KositHttpValidator)`, loggerCtx);
    }
    const injector = new Injector(this.moduleRef);
    for (const strategy of this.strategies()) {
      await strategy.init?.(injector);
    }
    await injector.get(EInvoiceDeliveryService).logSetupIssues();
  }

  /** @internal */
  async onApplicationShutdown() {
    for (const strategy of this.strategies()) {
      await strategy.destroy?.();
    }
  }

  private strategies() {
    const o = EInvoicePlugin.options;
    return [
      o.numberStrategy,
      o.sellerStrategy,
      o.buyerStrategy,
      o.formatStrategy,
      o.storage,
      o.pdfStrategy,
      o.validation.validator,
      o.delivery.strategy,
    ];
  }
}
