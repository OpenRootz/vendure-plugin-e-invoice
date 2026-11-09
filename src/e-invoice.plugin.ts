import { PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { PLUGIN_INIT_OPTIONS } from './constants';
import { EInvoicePluginOptions, resolveOptions, ResolvedEInvoicePluginOptions } from './options';

@VendurePlugin({
  imports: [PluginCommonModule],
  providers: [{ provide: PLUGIN_INIT_OPTIONS, useFactory: () => EInvoicePlugin.options }],
  compatibility: '^3.8.0',
})
export class EInvoicePlugin {
  static options: ResolvedEInvoicePluginOptions;

  static init(options: EInvoicePluginOptions): Type<EInvoicePlugin> {
    this.options = resolveOptions(options);
    return EInvoicePlugin;
  }
}
