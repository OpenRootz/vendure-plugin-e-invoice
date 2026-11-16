import { RequestContext } from '@vendure/core';

import { layoutTemplate, PdfDocDefinition, PdfTemplateInput } from '../core';

import { InvoicePdfStrategy } from './types';

/**
 * The channel's layout (layout editor), measured and fitted; the default layout if none is set.
 *
 * @category Strategies
 */
export class DefaultTemplatePdfStrategy implements InvoicePdfStrategy {
  buildDocDefinition(_ctx: RequestContext, input: PdfTemplateInput): Promise<PdfDocDefinition> {
    return layoutTemplate(input);
  }
}
