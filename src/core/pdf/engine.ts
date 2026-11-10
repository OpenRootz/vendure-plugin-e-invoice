import { compileLayout, CompileOptions, LayoutPlan, LayoutRenderInput, markerId } from './compile';
import { fromPt, LayoutBlock, LayoutIssue, MIN_FONT_SIZE, PdfLayoutV2, toPt } from './layout';
import { LayoutProbe, PdfDocDefinition, PdfFonts, probeLayout } from './printer';

/** Where a block ended up on a page, in 0.1 mm. A block that spans pages has one box per page. */
export interface BlockBox {
  /** The block's key */
  key: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Content that does not fit into a fixed frame (0.1 mm) */
  overflowBy?: number;
}

export interface LayoutMeasurement {
  pageCount: number;
  boxes: BlockBox[];
  /** Content height in pt of blocks that start and end on the same page (per page for fixed blocks) */
  contentHeight: Record<string, number>;
  /** Bottom (pt) and page of the end of each flow block */
  ends: Record<string, { page: number; top: number }>;
}

export interface LayoutResult {
  definition: PdfDocDefinition;
  plan: LayoutPlan;
  measurement: LayoutMeasurement;
  /** Warnings from laying out the real data: content that did not fit, chains pushed down */
  issues: LayoutIssue[];
  options: CompileOptions;
}

/** Content may exceed a frame by this much (pt) before it counts as overflowing (rounding of line heights). */
const TOLERANCE = 0.5;
const MAX_PASSES = 6;

/** Turns the marker positions of a layout pass into block boxes. */
export function measureLayout(layout: PdfLayoutV2, plan: LayoutPlan, probe: LayoutProbe, options: CompileOptions = {}): LayoutMeasurement {
  const starts = new Map<string, LayoutProbe['positions']>();
  const endsOf = new Map<string, LayoutProbe['positions']>();
  for (const p of probe.positions) {
    const m = /^b:(.+):(start|end)$/.exec(p.id);
    if (!m) continue;
    const map = m[2] === 'start' ? starts : endsOf;
    map.set(m[1], [...(map.get(m[1]) ?? []), p]);
  }
  const contTop = toPt(layout.continuation.top);
  const flowBottom = toPt(plan.pageHeight - layout.continuation.bottom);
  const boxes: BlockBox[] = [];
  const contentHeight: Record<string, number> = {};
  const ends: LayoutMeasurement['ends'] = {};

  for (const chain of plan.chains) {
    for (const block of chain) {
      const start = starts.get(block.key)?.[0];
      const end = endsOf.get(block.key)?.[0];
      if (!start || !end) continue;
      ends[block.key] = { page: end.page, top: end.top + (plan.empty.has(block.key) ? 0 : (options.pads?.[block.key] ?? 0)) };
      if (plan.empty.has(block.key)) continue;
      const x = block.frame.x;
      const w = block.frame.w;
      if (start.page === end.page) {
        const height = end.top - start.top;
        contentHeight[block.key] = height;
        const h = Math.max(fromPt(height), block.frame.h);
        const overflowBy =
          block.overflow === 'fixed' && height > toPt(block.frame.h) + TOLERANCE ? fromPt(height) - block.frame.h : undefined;
        boxes.push({
          key: block.key,
          page: start.page,
          x,
          y: fromPt(start.top),
          w,
          h: block.overflow === 'fixed' ? block.frame.h : h,
          ...(overflowBy ? { overflowBy } : {}),
        });
      } else {
        for (let page = start.page; page <= end.page; page++) {
          const top = page === start.page ? start.top : contTop;
          const bottom = page === end.page ? end.top : flowBottom;
          boxes.push({ key: block.key, page, x, y: fromPt(top), w, h: fromPt(bottom - top) });
        }
      }
    }
  }
  for (const block of plan.fixed) {
    if (plan.empty.has(block.key)) continue;
    const blockEnds = endsOf.get(block.key) ?? [];
    for (const start of starts.get(block.key) ?? []) {
      const end = blockEnds.find((e) => e.page === start.page);
      if (!end) continue;
      const height = end.top - start.top;
      contentHeight[block.key] = Math.max(contentHeight[block.key] ?? 0, height);
      const overflowBy = height > toPt(block.frame.h) + TOLERANCE ? fromPt(height) - block.frame.h : undefined;
      boxes.push({
        key: block.key,
        page: start.page,
        x: block.frame.x,
        y: plan.staticY[block.key],
        w: block.frame.w,
        h: block.frame.h,
        ...(overflowBy ? { overflowBy } : {}),
      });
    }
  }
  boxes.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  return { pageCount: probe.pageCount, boxes, contentHeight, ends };
}

export interface LayoutDocumentOptions {
  /**
   * Render time (default): fixed blocks whose content does not fit shrink their font down to 6 pt and are then
   * printed beyond their frame (never clipped). `false`: measure only, overflow is reported (layout checks).
   */
  fit?: boolean;
}

/**
 * Lays out a v2 layout with measuring passes: minimum heights, chain starts and the page count are corrected
 * from the measured positions; with `fit`, overflowing fixed blocks get a smaller font. Returns the final
 * document definition (page count resolved) and where every block ended up.
 */
export async function layoutDocument(
  layout: PdfLayoutV2,
  input: LayoutRenderInput,
  fonts: PdfFonts,
  opts: LayoutDocumentOptions = {},
): Promise<LayoutResult> {
  const fit = opts.fit ?? true;
  // The page count is part of the options: every pass is compiled fresh with a known count (pdfmake reports
  // each node to pageBreakBefore only once per definition)
  let options: CompileOptions = { pageCount: 1 };
  let compiled = compileLayout(layout, input, options);
  let measurement: LayoutMeasurement | undefined;
  let pushed: LayoutIssue[] = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const probe = await probeLayout(compiled.definition, fonts);
    measurement = measureLayout(layout, compiled.plan, probe, options);
    const next = adjust(layout, compiled.plan, measurement, options, fit);
    next.options.pageCount = measurement.pageCount;
    pushed = next.pushed;
    if (same(next.options, options)) break;
    options = next.options;
    compiled = compileLayout(layout, input, options);
  }
  // A fresh definition for the actual rendering (pdfmake annotates the nodes it lays out)
  const final = compileLayout(layout, input, options);
  const issues: LayoutIssue[] = [...pushed];
  for (const box of measurement!.boxes) {
    if (box.overflowBy && !issues.some((i) => i.code === 'LAYOUT_OVERFLOW' && i.blockKey === box.key)) {
      issues.push({
        level: 'warning',
        code: 'LAYOUT_OVERFLOW',
        message: `The content of block ${box.key} is ${(box.overflowBy / 10).toFixed(1)} mm taller than its frame${fit ? '; it is printed beyond the frame' : ''}`,
        blockKey: box.key,
      });
    }
  }
  for (const [key, scale] of Object.entries(options.fontScale ?? {})) {
    const block = layout.blocks.find((b) => b.key === key);
    if (!block || measurement!.boxes.some((b) => b.key === key && b.overflowBy)) continue;
    const size = Math.round((block.style?.fontSize ?? layout.theme.fontSize) * scale * 10) / 10;
    issues.push({
      level: 'warning',
      code: 'FONT_REDUCED',
      message: `The font of block ${key} is reduced to ${size} pt so that the content fits`,
      blockKey: key,
    });
  }
  return { definition: final.definition, plan: final.plan, measurement: measurement!, issues, options };
}

function adjust(layout: PdfLayoutV2, plan: LayoutPlan, m: LayoutMeasurement, current: CompileOptions, fit: boolean) {
  const pads: Record<string, number> = {};
  const chainStarts: Record<string, number> = {};
  const fontScale: Record<string, number> = { ...current.fontScale };
  const pushed: LayoutIssue[] = [];
  const round = (v: number) => Math.round(v * 100) / 100;

  for (const chain of plan.chains) {
    for (const block of chain) {
      const height = m.contentHeight[block.key];
      if (height === undefined || plan.empty.has(block.key)) continue;
      const pad = toPt(block.frame.h) - height;
      if (pad > 0.01) pads[block.key] = round(pad);
    }
  }
  plan.chains.forEach((chain, i) => {
    if (i === 0) return;
    const prev = plan.chains[i - 1];
    const end = m.ends[prev[prev.length - 1].key];
    if (!end) return;
    const wanted = toPt(plan.staticY[chain[0].key]);
    if (end.page === 1 && end.top <= wanted + TOLERANCE) {
      const gap = wanted - end.top;
      if (gap > 0.01) chainStarts[chain[0].key] = round(gap);
    } else {
      pushed.push({
        level: 'warning',
        code: 'CHAIN_PUSHED',
        message: `Block ${chain[0].key} starts below the end of block ${prev[prev.length - 1].key}, not at its own position`,
        blockKey: chain[0].key,
      });
    }
  });
  if (fit) {
    const all: LayoutBlock[] = [...plan.fixed, ...plan.chains.flat().filter((b) => b.overflow === 'fixed')];
    for (const block of all) {
      const height = m.contentHeight[block.key];
      const frame = toPt(block.frame.h);
      if (height === undefined || height <= frame + TOLERANCE) continue;
      const base = block.style?.fontSize ?? layout.theme.fontSize;
      const min = Math.min(1, MIN_FONT_SIZE / base);
      const scale = fontScale[block.key] ?? 1;
      if (scale <= min) continue;
      fontScale[block.key] = Math.max(min, Math.floor(scale * Math.min(0.95, frame / height) * 100) / 100);
    }
  }
  return {
    options: {
      ...(Object.keys(pads).length ? { pads } : {}),
      ...(Object.keys(chainStarts).length ? { chainStarts } : {}),
      ...(Object.keys(fontScale).length ? { fontScale } : {}),
    } as CompileOptions,
    pushed,
  };
}

const same = (a: CompileOptions, b: CompileOptions) => JSON.stringify(a) === JSON.stringify(b);

export { markerId };
