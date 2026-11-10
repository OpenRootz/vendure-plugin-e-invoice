import { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Injector, Logger, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { EInvoiceDownloadController } from './api/download.controller';
import { adminApiExtensions, shopApiExtensions } from './api/schema';
import { EInvoiceShopEntityResolver, EInvoiceShopOrderResolver } from './api/shop.resolver';
import {
  EInvoiceAdminResolver,
  EInvoiceEntityResolver,
  EInvoiceFileResolver,
  EInvoiceLayoutResolver,
  EInvoiceOrderResolver,
} from './api/admin.resolver';
import { eInvoicePermission, loggerCtx, PLUGIN_INIT_OPTIONS } from './constants';
import { customFields } from './custom-fields';
import {
  adaptJsonColumns,
  defineBlobColumn,
  EInvoice,
  EInvoiceBlob,
  EInvoiceChannelSettings,
  EInvoiceFile,
  EInvoiceSequence,
} from './entities';
import { OrderModelMapper } from './mapping/order-model.mapper';
import { EInvoicePluginOptions, resolveOptions, ResolvedEInvoicePluginOptions } from './options';
import { ChannelSettingsService } from './services/channel-settings.service';
import { CreditNoteService } from './services/credit-note.service';
import { DownloadLinkService } from './services/download-link.service';
import { NoopValidator } from './strategies/validator';
import { InvoiceNumberService } from './services/invoice-number.service';
import { InvoiceRenderService } from './services/invoice-render.service';
import { InvoiceService } from './services/invoice.service';
import { LayoutPreviewService } from './services/layout-preview.service';

@VendurePlugin({
  imports: [PluginCommonModule],
  entities: [EInvoice, EInvoiceFile, EInvoiceSequence, EInvoiceChannelSettings, EInvoiceBlob],
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
  ],
  controllers: [EInvoiceDownloadController],
  adminApiExtensions: {
    schema: adminApiExtensions,
    resolvers: [EInvoiceAdminResolver, EInvoiceEntityResolver, EInvoiceFileResolver, EInvoiceOrderResolver, EInvoiceLayoutResolver],
  },
  shopApiExtensions: {
    schema: shopApiExtensions,
    resolvers: [EInvoiceShopOrderResolver, EInvoiceShopEntityResolver, EInvoiceFileResolver],
  },
  configuration: (config) => {
    const options = EInvoicePlugin.options;
    defineBlobColumn(config.dbConnectionOptions.type);
    adaptJsonColumns(config.dbConnectionOptions.type);
    config.authOptions.customPermissions.push(eInvoicePermission);
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
  static options: ResolvedEInvoicePluginOptions;

  constructor(private moduleRef: ModuleRef) {}

  static init(options: EInvoicePluginOptions): Type<EInvoicePlugin> {
    this.options = resolveOptions(options);
    return EInvoicePlugin;
  }

  async onApplicationBootstrap() {
    const { validation } = EInvoicePlugin.options;
    if (validation.mode !== 'off' && validation.validator instanceof NoopValidator) {
      Logger.warn(`validation.mode is '${validation.mode}', but no validator is configured (e.g. KositHttpValidator)`, loggerCtx);
    }
    const injector = new Injector(this.moduleRef);
    for (const strategy of this.strategies()) {
      await strategy.init?.(injector);
    }
  }

  async onApplicationShutdown() {
    for (const strategy of this.strategies()) {
      await strategy.destroy?.();
    }
  }

  private strategies() {
    const o = EInvoicePlugin.options;
    return [o.numberStrategy, o.sellerStrategy, o.buyerStrategy, o.formatStrategy, o.storage, o.pdfStrategy, o.validation.validator];
  }
}
