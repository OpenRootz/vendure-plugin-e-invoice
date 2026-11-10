import { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Injector, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { adminApiExtensions } from './api/schema';
import { EInvoiceAdminResolver, EInvoiceEntityResolver, EInvoiceFileResolver, EInvoiceOrderResolver } from './api/admin.resolver';
import { eInvoicePermission, PLUGIN_INIT_OPTIONS } from './constants';
import { customFields } from './custom-fields';
import {
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
import { InvoiceNumberService } from './services/invoice-number.service';
import { InvoiceRenderService } from './services/invoice-render.service';
import { InvoiceService } from './services/invoice.service';

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
  ],
  adminApiExtensions: {
    schema: adminApiExtensions,
    resolvers: [EInvoiceAdminResolver, EInvoiceEntityResolver, EInvoiceFileResolver, EInvoiceOrderResolver],
  },
  configuration: (config) => {
    const options = EInvoicePlugin.options;
    defineBlobColumn(config.dbConnectionOptions.type);
    config.authOptions.customPermissions.push(eInvoicePermission);
    const fields = customFields({ exposeBuyerFieldsInShop: options.exposeBuyerFieldsInShop });
    config.customFields.Customer.push(...fields.Customer);
    config.customFields.Order.push(...fields.Order);
    config.customFields.TaxRate.push(...fields.TaxRate);
    config.customFields.PaymentMethod.push(...fields.PaymentMethod);
    return config;
  },
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
    return [o.numberStrategy, o.sellerStrategy, o.buyerStrategy, o.formatStrategy, o.storage, o.pdfStrategy];
  }
}
