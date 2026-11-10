import { EInvoiceModel } from '../model';

import { exemptionTexts } from './blocks';
import type { LayoutMeasurement } from './engine';
import {
  BlockType,
  DETAIL_FIELDS,
  DetailField,
  LayoutBlock,
  LayoutIssue,
  MIN_FONT_SIZE,
  PAGE_SIZES,
  PdfLayoutV2,
  validColor,
} from './layout';

/** Content §14 Abs. 4 UStG requires on an invoice, and the blocks that can carry it. */
export type MandatoryField =
  'sellerAddress' | 'sellerTaxId' | 'buyerAddress' | 'number' | 'issueDate' | 'deliveryDate' | 'lines' | 'vatBreakdown' | 'exemption';

export const MANDATORY_FIELDS: { field: MandatoryField; label: string }[] = [
  { field: 'sellerAddress', label: 'Seller name and address' },
  { field: 'sellerTaxId', label: 'Seller VAT ID or tax number' },
  { field: 'buyerAddress', label: 'Buyer name and address' },
  { field: 'number', label: 'Invoice number' },
  { field: 'issueDate', label: 'Invoice date' },
  { field: 'deliveryDate', label: 'Delivery date' },
  { field: 'lines', label: 'Quantity and description of the goods or services' },
  { field: 'vatBreakdown', label: 'Net amounts, VAT rates and amounts, total' },
  { field: 'exemption', label: 'VAT exemption note' },
];

const detailFields = (b: LayoutBlock): DetailField[] =>
  Array.isArray(b.props?.fields) ? (b.props.fields as DetailField[]) : DETAIL_FIELDS.filter((f) => f !== 'sellerTaxId');

/** The mandatory fields a block renders. */
export function blockCoverage(block: LayoutBlock): MandatoryField[] {
  const byType: Partial<Record<BlockType, MandatoryField[]>> = {
    senderLine: ['sellerAddress'],
    footer: ['sellerAddress', 'sellerTaxId'],
    recipient: ['buyerAddress'],
    title: ['number'],
    lines: ['lines'],
    totals: ['vatBreakdown'],
    exemptionNotes: ['exemption'],
  };
  if (block.type === 'details') {
    const fields = detailFields(block);
    const map: Partial<Record<DetailField, MandatoryField>> = {
      number: 'number',
      issueDate: 'issueDate',
      deliveryDate: 'deliveryDate',
      sellerTaxId: 'sellerTaxId',
    };
    return fields.map((f) => map[f]).filter((f): f is MandatoryField => !!f);
  }
  return byType[block.type] ?? [];
}

/** Visible blocks per mandatory field. */
export function layoutCoverage(layout: PdfLayoutV2): Record<MandatoryField, string[]> {
  const out = Object.fromEntries(MANDATORY_FIELDS.map((f) => [f.field, [] as string[]])) as Record<MandatoryField, string[]>;
  for (const b of layout.blocks.filter((x) => x.visible)) for (const f of blockCoverage(b)) out[f].push(b.key);
  return out;
}

/** Relative luminance contrast of a color against white (WCAG). */
function contrastOnWhite(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (l + 0.05);
}

/** DIN 5008 address window incl. the return address zone, 0.1 mm: Form A and Form B. */
const WINDOWS = { A: { x: 200, y: 270, w: 850, h: 450 }, B: { x: 200, y: 450, w: 850, h: 450 } };

export interface CheckLayoutOptions {
  /** Font families available (`pdf.fonts`) */
  fonts?: string[];
}

/**
 * Checks a layout for what would make the PDF incomplete or hard to read. Errors block saving:
 * - content coverage: every §14 UStG field is printed by a visible block (exemption notes only if the model
 *   has non-standard VAT categories);
 * - clipping: content of a fixed block exceeds its frame (in `measurement`, e.g. of the worst-case sample; measured
 *   with `fit`, only content that does not fit even with the font reduced to 6 pt);
 * - frames outside the page, two growing blocks side by side, unknown font.
 * Warnings: the 5 mm unprintable border, overlapping blocks, the DIN 5008 window, small fonts, low contrast.
 */
export function checkLayout(
  layout: PdfLayoutV2,
  measurement?: LayoutMeasurement,
  model?: EInvoiceModel,
  options: CheckLayoutOptions = {},
): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const add = (level: LayoutIssue['level'], code: string, message: string, blockKey?: string) =>
    issues.push({ level, code, message, blockKey });
  const page = PAGE_SIZES[layout.page.size];
  const visible = layout.blocks.filter((b) => b.visible);

  // --- content coverage ---
  const coverage = layoutCoverage(layout);
  const needsExemption = model ? exemptionTexts(model).length > 0 : true;
  for (const { field, label } of MANDATORY_FIELDS) {
    if (field === 'exemption' && !needsExemption) continue;
    if (!coverage[field].length) add('error', 'MANDATORY_CONTENT_MISSING', `No visible block prints: ${label}`);
  }

  // --- frames ---
  for (const b of visible) {
    const { x, y, w, h } = b.frame;
    const anchored = !!b.anchor;
    if (x < 0 || x + w > page.w || (!anchored && (y < 0 || y + h > page.h))) {
      add('error', 'OUT_OF_PAGE', `Block ${b.key} is (partly) outside the page`, b.key);
    } else if (x < 50 || x + w > page.w - 50 || (!anchored && (y < 50 || y + h > page.h - 50))) {
      add('warning', 'UNPRINTABLE_AREA', `Block ${b.key} reaches into the 5 mm border most printers cannot print`, b.key);
    }
    if (b.overflow === 'grow' && !anchored && y < layout.continuation.top) {
      add(
        'warning',
        'FLOW_ABOVE_TOP',
        `Block ${b.key} grows, so it cannot start above the flow area (${layout.continuation.top / 10} mm)`,
        b.key,
      );
    }
  }

  // --- no parallel growth: unanchored growing blocks side by side ---
  const heads = visible.filter((b) => b.overflow === 'grow' && !b.anchor);
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      const [a, b] = [heads[i], heads[j]];
      const sideBySide = a.frame.x + a.frame.w <= b.frame.x || b.frame.x + b.frame.w <= a.frame.x;
      const band = Math.max(a.frame.h, b.frame.h, 50);
      if (sideBySide && Math.abs(a.frame.y - b.frame.y) < band) {
        add(
          'error',
          'PARALLEL_GROWTH',
          `Blocks ${a.key} and ${b.key} both grow and stand side by side; make one of them fixed or anchor it below the other`,
          b.key,
        );
      }
    }
  }

  // --- measured: clipping and overlap ---
  if (measurement) {
    for (const box of measurement.boxes) {
      if (box.overflowBy) {
        add(
          'error',
          'CLIPPED',
          `The content of block ${box.key} does not fit into its frame (${(box.overflowBy / 10).toFixed(1)} mm too tall); make the frame larger or the font smaller`,
          box.key,
        );
      }
    }
    const boxes = measurement.boxes.filter((bx) => visible.some((b) => b.key === bx.key) && bx.h > 0);
    const reported = new Set<string>();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a.page !== b.page || a.key === b.key) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        const key = [a.key, b.key].sort().join('|');
        if (overlap && !reported.has(key)) {
          reported.add(key);
          add('warning', 'OVERLAP', `Blocks ${a.key} and ${b.key} overlap on page ${a.page}`, b.key);
        }
      }
    }
  }

  // --- DIN 5008 window ---
  if (layout.windowEnvelope) {
    const win = WINDOWS[layout.windowEnvelope];
    for (const b of visible.filter((x) => x.type === 'recipient' || x.type === 'senderLine')) {
      const { x, y, w, h } = b.frame;
      if (b.anchor || x < win.x || y < win.y || x + w > win.x + win.w || y + h > win.y + win.h) {
        add(
          'warning',
          'NOT_IN_WINDOW',
          `Block ${b.key} is not inside the window of a DIN 5008 Form ${layout.windowEnvelope} envelope`,
          b.key,
        );
      }
    }
  }

  // --- readability ---
  if (layout.theme.fontSize < MIN_FONT_SIZE) add('warning', 'SMALL_FONT', `The base font size is below ${MIN_FONT_SIZE} pt`);
  for (const b of visible) {
    if (b.style?.fontSize !== undefined && b.style.fontSize < MIN_FONT_SIZE)
      add('warning', 'SMALL_FONT', `Block ${b.key} uses a font below ${MIN_FONT_SIZE} pt`, b.key);
    if (b.style?.color && validColor(b.style.color) && contrastOnWhite(b.style.color) < 3) {
      add('warning', 'LOW_CONTRAST', `The text color of block ${b.key} has too little contrast on white`, b.key);
    }
  }
  if (validColor(layout.theme.accentColor) && contrastOnWhite(layout.theme.accentColor) < 3) {
    add('warning', 'LOW_CONTRAST', 'The accent color has too little contrast on white (below 3:1)');
  }
  if (layout.theme.font && options.fonts && !options.fonts.includes(layout.theme.font)) {
    add('error', 'UNKNOWN_FONT', `The font "${layout.theme.font}" is not configured (pdf.fonts: ${options.fonts.join(', ')})`);
  }
  return issues;
}
