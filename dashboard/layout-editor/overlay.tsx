import { useRef, useState } from 'react';

import { displayRect, flowBlocks, MIN_SIZE } from './geometry';
import { LinkIcon, LockIcon } from './icons';
import { Block, BlockBox, BLOCK_LABELS, dependsOn, Frame, LayoutDocument, LayoutIssue, PAGE, updateBlock } from './model';

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Exclude<Handle, 'move'>[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const SNAP = 20; // 2 mm
const GRID = 10; // 1 mm
function snap(value: number, candidates: number[], free: boolean): { value: number; snapped: boolean } {
  if (free) return { value: Math.round(value), snapped: false };
  let best: number | undefined;
  for (const c of candidates)
    if (Math.abs(c - value) <= SNAP && (best === undefined || Math.abs(c - value) < Math.abs(best - value))) best = c;
  return best !== undefined ? { value: best, snapped: true } : { value: Math.round(value / GRID) * GRID, snapped: false };
}

interface Props {
  layout: LayoutDocument;
  boxes: BlockBox[];
  page: number;
  pageCount: number;
  /** CSS px per 0.1 mm */
  scale: number;
  selected?: string;
  locked: Set<string>;
  issues: LayoutIssue[];
  onSelect: (key: string | undefined) => void;
  onChange: (layout: LayoutDocument) => void;
}

/**
 * The editing layer above the rendered PDF: block frames, selection, drag and resize (pointer events), guides for
 * the margins, the flow area and the DIN 5008 window. While dragging only this layer moves; the PDF is rendered
 * again after the drop.
 */
export function LayoutOverlay({ layout, boxes, page, pageCount, scale, selected, locked, issues, onSelect, onChange }: Props) {
  const [drag, setDrag] = useState<{ key: string; rect: Frame } | undefined>();
  const start = useRef<{ key: string; handle: Handle; px: number; py: number; rect: Frame } | undefined>(undefined);
  const flow = flowBlocks(layout);
  const byKey = new Map(layout.blocks.map((b) => [b.key, b]));
  const rects = layout.blocks
    .map((b) => ({ block: b, rect: drag?.key === b.key ? drag.rect : displayRect(b, boxes, page, pageCount, flow, byKey) }))
    .filter((r): r is { block: Block; rect: Frame } => !!r.rect);
  const px = (v: number) => v * scale;
  const [mt, mr, mb, ml] = layout.page.margins;

  const candidates = (key: string) => {
    const others = rects.filter((r) => r.block.key !== key && r.block.visible);
    return {
      xs: [ml, PAGE.w - mr, ...others.flatMap((r) => [r.rect.x, r.rect.x + r.rect.w])],
      ys: [
        mt,
        PAGE.h - mb,
        layout.continuation.top,
        PAGE.h - layout.continuation.bottom,
        ...others.flatMap((r) => [r.rect.y, r.rect.y + r.rect.h]),
      ],
    };
  };

  const onPointerDown = (e: React.PointerEvent, block: Block, rect: Frame, handle: Handle) => {
    e.stopPropagation();
    onSelect(block.key);
    if (locked.has(block.key) || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { key: block.key, handle, px: e.clientX, py: e.clientY, rect };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = (e.clientX - s.px) / scale;
    const dy = (e.clientY - s.py) / scale;
    if (!drag && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    const { xs, ys } = candidates(s.key);
    const free = e.shiftKey;
    let { x, y, w, h } = s.rect;
    if (s.handle === 'move') {
      const left = snap(x + dx, xs, free);
      const right = snap(x + dx + w, xs, free);
      x = left.snapped || !right.snapped ? left.value : right.value - w;
      const top = snap(y + dy, ys, free);
      const bottom = snap(y + dy + h, ys, free);
      y = top.snapped || !bottom.snapped ? top.value : bottom.value - h;
    } else {
      if (s.handle.includes('w')) {
        const nx = Math.min(snap(x + dx, xs, free).value, x + w - MIN_SIZE);
        w += x - nx;
        x = nx;
      }
      if (s.handle.includes('e')) w = Math.max(MIN_SIZE, snap(x + w + dx, xs, free).value - x);
      if (s.handle.includes('n')) {
        const ny = Math.min(snap(y + dy, ys, free).value, y + h - MIN_SIZE);
        h += y - ny;
        y = ny;
      }
      if (s.handle.includes('s')) h = Math.max(MIN_SIZE, snap(y + h + dy, ys, free).value - y);
    }
    setDrag({ key: s.key, rect: { x, y, w, h } });
  };

  const onPointerUp = () => {
    const s = start.current;
    start.current = undefined;
    if (!s || !drag) return setDrag(undefined);
    const block = layout.blocks.find((b) => b.key === s.key)!;
    const r = drag.rect;
    const moved = Math.abs(r.y - s.rect.y) > 5;
    // A resized grow block keeps its height as minimum height; flow blocks keep their content height
    const h =
      s.handle === 'move'
        ? block.frame.h
        : flow.has(block.key) && block.overflow === 'grow' && !/[ns]/.test(s.handle)
          ? block.frame.h
          : r.h;
    let next = updateBlock(layout, block.key, (b) => ({
      ...b,
      frame: { x: r.x, y: r.y, w: r.w, h },
      anchor: moved ? undefined : b.anchor,
    }));
    if (moved) {
      // Snap anchor: dropped right below a growing block → follows it
      const target = rects.find(
        (o) =>
          o.block.key !== block.key &&
          o.block.visible &&
          flow.has(o.block.key) &&
          r.y >= o.rect.y + o.rect.h - 5 &&
          r.y <= o.rect.y + o.rect.h + 60 &&
          r.x < o.rect.x + o.rect.w &&
          o.rect.x < r.x + r.w &&
          !layout.blocks.some((b) => b.anchor?.to === o.block.key && b.key !== block.key) &&
          !dependsOn(layout, o.block.key, block.key),
      );
      if (target)
        next = updateBlock(next, block.key, {
          anchor: { to: target.block.key, gap: Math.max(0, Math.round(r.y - (target.rect.y + target.rect.h))) },
        });
    }
    setDrag(undefined);
    onChange(next);
  };

  const win = layout.windowEnvelope ? { A: 270, B: 450 }[layout.windowEnvelope] : undefined;
  const issueOf = (key: string) => issues.find((i) => i.blockKey === key && i.level === 'error') ?? issues.find((i) => i.blockKey === key);

  return (
    <div
      className="absolute left-0 top-0"
      style={{ width: px(PAGE.w), height: px(PAGE.h) }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerDown={() => onSelect(undefined)}
    >
      {/* guides: page margins, flow area, DIN window */}
      <div
        className="pointer-events-none absolute border border-dashed border-sky-300/70"
        style={{ left: px(ml), top: px(mt), width: px(PAGE.w - ml - mr), height: px(PAGE.h - mt - mb) }}
      />
      <div
        className="pointer-events-none absolute border-t border-dotted border-violet-400/70"
        style={{ left: 0, width: px(PAGE.w), top: px(PAGE.h - layout.continuation.bottom) }}
        title="End of the flow area"
      />
      {win !== undefined && (
        <div
          className="pointer-events-none absolute border border-amber-500/70"
          style={{ left: px(200), top: px(win), width: px(850), height: px(450) }}
        />
      )}
      {rects.map(({ block, rect }) => {
        const isSelected = block.key === selected;
        const issue = issueOf(block.key);
        const color =
          issue?.level === 'error' ? 'border-red-500' : issue ? 'border-amber-500' : isSelected ? 'border-primary' : 'border-sky-500/50';
        return (
          <div
            key={block.key}
            role="button"
            tabIndex={-1}
            aria-label={`${BLOCK_LABELS[block.type]} (${block.key})`}
            title={issue?.message ?? `${BLOCK_LABELS[block.type]} (${block.key})`}
            className={`absolute border ${isSelected ? 'border-2 bg-primary/5' : 'border-dashed hover:bg-sky-500/5'} ${color} ${block.visible ? '' : 'opacity-40'} ${
              locked.has(block.key) ? 'cursor-default' : 'cursor-move'
            }`}
            style={{ left: px(rect.x), top: px(rect.y), width: px(rect.w), height: px(rect.h) }}
            onPointerDown={(e) => onPointerDown(e, block, rect, 'move')}
          >
            <span className="pointer-events-none absolute -top-4 left-0 flex items-center gap-0.5 whitespace-nowrap rounded bg-background/80 px-1 text-[10px] leading-4 text-muted-foreground">
              {BLOCK_LABELS[block.type]}
              {block.anchor && <LinkIcon className="h-2.5 w-2.5" />}
              {locked.has(block.key) && <LockIcon className="h-2.5 w-2.5" />}
            </span>
            {isSelected &&
              !locked.has(block.key) &&
              HANDLES.map((h) => (
                <span
                  key={h}
                  className="absolute h-2 w-2 rounded-sm border border-primary bg-background"
                  style={{
                    left: h.includes('w') ? -4 : h.includes('e') ? 'calc(100% - 4px)' : 'calc(50% - 4px)',
                    top: h.includes('n') ? -4 : h.includes('s') ? 'calc(100% - 4px)' : 'calc(50% - 4px)',
                    cursor: `${h}-resize`,
                  }}
                  onPointerDown={(e) => onPointerDown(e, block, rect, h)}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}
