import { EInvoiceModel } from '../model';

import { PdfImage } from './blocks';
import { compileLayout } from './compile';
import { layoutDocument, LayoutResult } from './engine';
import { PdfLabels } from './i18n';
import { isLayoutV2, layoutFromV1, PdfLayout, PdfLayoutV2 } from './layout';
import { defaultFonts, PdfDocDefinition, PdfFonts } from './printer';

export interface PdfTemplateInput {
  model: EInvoiceModel;
  labels: PdfLabels;
  /** The channel's layout (v2); v1 settings (accent color and texts) are converted */
  layout?: PdfLayoutV2 | PdfLayout;
  /** Logo as a PNG/JPEG data URL or as SVG markup */
  logo?: PdfImage;
  /** Images of `image` blocks by asset id */
  images?: Record<string, PdfImage>;
  /** The configured fonts (`pdf.fonts`), for measuring */
  fonts?: PdfFonts;
  /** Called by {@link layoutTemplate} with the measured layout (preview boxes, overflow warnings) */
  onLayout?: (result: LayoutResult) => void;
}

/** The v2 layout of the input (the default layout if none is set). */
export function resolveLayout(layout: PdfTemplateInput['layout']): PdfLayoutV2 {
  return isLayoutV2(layout) ? layout : layoutFromV1(layout ?? {});
}

/**
 * The invoice layout as a pdfmake document definition, without measuring: minimum heights of growing blocks and
 * the start of additional flow chains are not corrected, and overflowing fixed blocks are not shrunk. The default
 * layout needs none of that. The page count is resolved by the printer.
 *
 * Amounts in the totals block are always the XML values. Line prices are shown net or gross depending on
 * `model.meta.priceDisplay`.
 */
export function defaultTemplate(input: PdfTemplateInput): PdfDocDefinition {
  return compileLayout(resolveLayout(input.layout), input).definition;
}

/** {@link defaultTemplate} with measuring passes (see `layoutDocument`): what the built-in PDF strategy renders. */
export async function layoutTemplate(input: PdfTemplateInput): Promise<PdfDocDefinition> {
  const result = await layoutDocument(resolveLayout(input.layout), input, input.fonts ?? defaultFonts());
  input.onLayout?.(result);
  return result.definition;
}
