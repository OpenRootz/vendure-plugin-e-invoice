import { Block, BlockBox, Frame, LayoutDocument, onPage } from './model';

/** Smallest size of a block frame (3 mm). */
export const MIN_SIZE = 30;

/**
 * Where a block is drawn on the page: its measured box, else (fixed blocks) its frame on the pages it prints on.
 * A flow block without a box on this page is printed on another page, so it is not drawn here, or it is empty:
 * then it is drawn where the flow puts it, right below the block it follows.
 */
export function displayRect(
  block: Block,
  boxes: BlockBox[],
  page: number,
  pageCount: number,
  flow: Set<string>,
  byKey: Map<string, Block>,
): Frame | undefined {
  const box = boxes.find((b) => b.key === block.key && b.page === page);
  if (box) return { x: box.x, y: box.y, w: box.w, h: Math.max(box.h, block.frame.h) };
  if (!flow.has(block.key)) return onPage(block, page, pageCount) ? frameRect(block) : undefined;
  const end = flowEnd(block, boxes, flow, byKey);
  return end?.page === page ? end.rect : undefined;
}

const frameRect = (block: Block): Frame => ({ ...block.frame, h: Math.max(block.frame.h, MIN_SIZE) });

/** The page and the last box of a flow block; an empty one follows the block it is anchored to. */
function flowEnd(
  block: Block,
  boxes: BlockBox[],
  flow: Set<string>,
  byKey: Map<string, Block>,
  depth = 0,
): { page: number; rect: Frame } | undefined {
  const own = boxes.filter((b) => b.key === block.key);
  if (own.length) {
    const last = own.reduce((a, b) => (b.page > a.page || (b.page === a.page && b.y > a.y) ? b : a));
    return { page: last.page, rect: { x: last.x, y: last.y, w: last.w, h: Math.max(last.h, block.frame.h) } };
  }
  const target = block.anchor && byKey.get(block.anchor.to);
  if (!flow.has(block.key) || !target || depth > 60) return { page: 1, rect: frameRect(block) };
  const above = flowEnd(target, boxes, flow, byKey, depth + 1);
  if (!above) return undefined;
  const y = above.rect.y + above.rect.h + (block.anchor?.gap ?? 0);
  return { page: above.page, rect: { x: block.frame.x, y, w: block.frame.w, h: MIN_SIZE } };
}

/** Blocks that grow or are anchored to a growing block (they are laid out in the flow). */
export function flowBlocks(layout: LayoutDocument): Set<string> {
  const byKey = new Map(layout.blocks.map((b) => [b.key, b]));
  const flow = new Set<string>();
  const check = (b: Block, depth = 0): boolean => {
    if (b.overflow === 'grow') return true;
    const target = b.anchor && byKey.get(b.anchor.to);
    return !!target && depth < 60 && check(target, depth + 1);
  };
  for (const b of layout.blocks) if (check(b)) flow.add(b.key);
  return flow;
}
