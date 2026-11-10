import { EInvoiceModel } from '../model';

import { blockRenderers, BlockContext, PdfImage, PdfNode } from './blocks';
import { formatters, PdfLabels } from './i18n';
import { DEFAULT_ACCENT, LayoutBlock, PAGE_SIZES, PdfLayoutV2, toPt, validColor } from './layout';
import { PdfDocDefinition } from './printer';

/** What the layout is rendered with (the model, labels and loaded images). */
export interface LayoutRenderInput {
  model: EInvoiceModel;
  labels: PdfLabels;
  logo?: PdfImage;
  /** Images of `image` blocks by asset id */
  images?: Record<string, PdfImage>;
}

/** Corrections from a measuring pass (see `layoutDocument`); all in pt. */
export interface CompileOptions {
  /** Space below a block so it reaches its minimum height (grow) or its frame height (fixed, in the flow) */
  pads?: Record<string, number>;
  /** Space above the head of a flow chain that does not start right after the previous chain */
  chainStarts?: Record<string, number>;
  /** Font size factor of a block (fixed blocks whose content does not fit) */
  fontScale?: Record<string, number>;
  /** Known page count; otherwise the printer lays the document out twice when the guess (1) was wrong */
  pageCount?: number;
}

/** The structure the compiled document follows, used to measure and check it. */
export interface LayoutPlan {
  /** Blocks laid out in the flow, by chain (head first), chains in page order */
  chains: LayoutBlock[][];
  /** Blocks placed absolutely on their pages (in the page background) */
  fixed: LayoutBlock[];
  /** y in 0.1 mm of fixed blocks and chain heads (after resolving anchors to fixed blocks) */
  staticY: Record<string, number>;
  /** Blocks that rendered nothing (hidden or without content); they collapse in the flow */
  empty: Set<string>;
  pageWidth: number;
  pageHeight: number;
}

/** A page-count holder: blocks that print the page count read it while the page backgrounds are laid out. */
export interface PageCountRef {
  value: number;
  /** false: the value is a guess; the printer lays the document out again with the real count */
  resolved: boolean;
}

export const markerId = (blockId: string, edge: 'start' | 'end') => `b:${blockId}:${edge}`;

/** An invisible node with a height of ~0 whose position pdfmake reports to `pageBreakBefore`. */
const marker = (blockId: string, edge: 'start' | 'end'): PdfNode => ({ text: ' ', fontSize: 0.01, lineHeight: 0, id: markerId(blockId, edge) });

/**
 * Compiles a v2 layout into a pdfmake document definition:
 * - blocks that grow (and blocks anchored to them) form flow chains in `content`; each block is placed at its
 *   frame's x/width via margins, the chain head at its frame's y, followers at the anchor gap;
 * - all other blocks are placed absolutely in the page `background`, on the pages given by `pages`.
 * Every block is wrapped in start/end markers so a measuring pass can report where it ended up.
 */
export function compileLayout(
  layout: PdfLayoutV2,
  input: LayoutRenderInput,
  options: CompileOptions = {},
): { definition: PdfDocDefinition; plan: LayoutPlan } {
  const { model, labels } = input;
  const size = PAGE_SIZES[layout.page.size];
  const pageW = toPt(size.w);
  const f = formatters(labels, model.currencyCode, model.amountDecimals);
  const accent = validColor(layout.theme.accentColor) ? layout.theme.accentColor : DEFAULT_ACCENT;
  const byId = new Map(layout.blocks.map((b) => [b.id, b]));
  const pageCountRef: PageCountRef = { value: options.pageCount ?? 1, resolved: options.pageCount !== undefined };

  // --- flow membership and static positions ---
  const flowMemo = new Map<string, boolean>();
  const inFlow = (b: LayoutBlock): boolean => {
    if (flowMemo.has(b.id)) return flowMemo.get(b.id)!;
    const target = b.anchor && byId.get(b.anchor.to);
    const result = b.overflow === 'grow' || (!!target && inFlow(target));
    flowMemo.set(b.id, result);
    return result;
  };
  const staticY: Record<string, number> = {};
  const yOf = (b: LayoutBlock, depth = 0): number => {
    if (staticY[b.id] !== undefined) return staticY[b.id];
    const target = b.anchor && byId.get(b.anchor.to);
    const y = target && !inFlow(target) && depth < 60 ? yOf(target, depth + 1) + target.frame.h + b.anchor!.gap : b.frame.y;
    staticY[b.id] = y;
    return y;
  };

  const follower = new Map<string, LayoutBlock>();
  for (const b of layout.blocks) if (b.anchor && byId.has(b.anchor.to)) follower.set(b.anchor.to, b);
  const heads = layout.blocks.filter((b) => inFlow(b) && !(b.anchor && byId.get(b.anchor.to) && inFlow(byId.get(b.anchor.to)!)));
  for (const b of layout.blocks) yOf(b);
  heads.sort((a, b) => staticY[a.id] - staticY[b.id] || a.frame.x - b.frame.x);
  const chains = heads.map((head) => {
    const chain = [head];
    for (let next = follower.get(head.id); next && chain.length <= layout.blocks.length; next = follower.get(next.id)) chain.push(next);
    return chain;
  });
  const fixed = layout.blocks.filter((b) => !inFlow(b));

  // --- block content ---
  const empty = new Set<string>();
  const render = (block: LayoutBlock, page?: number, pageCount?: number): PdfNode | null => {
    if (!block.visible) return null;
    const ctx: BlockContext = {
      model,
      labels,
      f,
      accent,
      block,
      width: toPt(block.frame.w),
      height: toPt(block.frame.h),
      logo: input.logo,
      images: input.images ?? {},
      page,
      pageCount,
    };
    return blockRenderers[block.type](ctx);
  };
  const styled = (block: LayoutBlock, node: PdfNode): Record<string, unknown> => {
    const s = block.style ?? {};
    const scale = options.fontScale?.[block.id] ?? 1;
    const fontSize = s.fontSize ?? (scale !== 1 ? layout.theme.fontSize : undefined);
    return {
      stack: [node],
      ...(fontSize !== undefined ? { fontSize: Math.round(fontSize * scale * 100) / 100 } : {}),
      ...(s.bold !== undefined ? { bold: s.bold } : {}),
      ...(s.align ? { alignment: s.align } : {}),
      ...(s.color ? { color: s.color } : {}),
    };
  };

  // --- flow ---
  const contTop = toPt(layout.continuation.top);
  const content: PdfNode[] = [];
  chains.forEach((chain, chainIndex) => {
    chain.forEach((block, i) => {
      const node = render(block);
      if (!node) empty.add(block.id);
      let top: number;
      if (i === 0) {
        top = chainIndex === 0 ? Math.max(0, toPt(staticY[block.id]) - contTop) : 0;
        top += options.chainStarts?.[block.id] ?? 0;
      } else {
        top = node ? toPt(block.anchor!.gap) : 0;
      }
      const x = toPt(block.frame.x);
      const w = toPt(block.frame.w);
      content.push({
        stack: [marker(block.id, 'start'), ...(node ? [styled(block, node)] : []), marker(block.id, 'end')],
        margin: [x, top, Math.max(0, pageW - x - w), node ? (options.pads?.[block.id] ?? 0) : 0],
        ...(block.overflow === 'fixed' ? { unbreakable: true } : {}),
      });
    });
  });

  // --- fixed blocks in the page background ---
  const onPage = (block: LayoutBlock, page: number, count: number) =>
    block.pages === 'all' || (block.pages === 'first' && page === 1) || (block.pages === 'following' && page > 1) || (block.pages === 'last' && page === count);
  for (const block of fixed) if (!render(block, 1, 1)) empty.add(block.id);
  const background = (page: number) => {
    const count = pageCountRef.value;
    const nodes = fixed
      .filter((b) => b.visible && onPage(b, page, count))
      .map((block) => {
        const node = render(block, page, count);
        if (!node) return null;
        return {
          absolutePosition: { x: toPt(block.frame.x), y: toPt(staticY[block.id]) },
          columns: [{ width: toPt(block.frame.w), stack: [marker(block.id, 'start'), styled(block, node), marker(block.id, 'end')] }],
        };
      })
      .filter((n) => n !== null);
    return nodes.length ? { stack: nodes } : null;
  };

  const definition: PdfDocDefinition = {
    pageSize: layout.page.size,
    pageMargins: [0, contTop, 0, toPt(layout.continuation.bottom)],
    defaultStyle: { fontSize: layout.theme.fontSize, lineHeight: 1.15, ...(layout.theme.font ? { font: layout.theme.font } : {}) },
    content,
    background,
    pageCountRef,
  };
  return { definition, plan: { chains, fixed, staticY, empty, pageWidth: size.w, pageHeight: size.h } };
}
