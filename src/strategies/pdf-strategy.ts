import { RequestContext } from '@vendure/core';

import { defaultTemplate, PdfDocDefinition, PdfTemplateInput } from '../core';

import { InvoicePdfStrategy } from './types';

/** The built-in A4 layout (see `defaultTemplate`); logo, accent color and texts come from the channel settings. */
export class DefaultTemplatePdfStrategy implements InvoicePdfStrategy {
  buildDocDefinition(_ctx: RequestContext, input: PdfTemplateInput): PdfDocDefinition {
    return defaultTemplate(input);
  }
}
