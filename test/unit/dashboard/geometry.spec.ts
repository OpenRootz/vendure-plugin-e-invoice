import { describe, expect, it } from 'vitest';

import { Block, BlockBox } from '../../../dashboard/layout-editor/model';
import { displayRect, flowBlocks } from '../../../dashboard/layout-editor/geometry';

const block = (b: Partial<Block> & Pick<Block, 'key' | 'type'>): Block => ({
  visible: true,
  pages: 'first',
  overflow: 'fixed',
  frame: { x: 200, y: 0, w: 1700, h: 0 },
  ...b,
});

// Line items grow over two pages; totals follow them; notes and payment are empty; the logo is fixed
const blocks = [
  block({ key: 'logo', type: 'logo', frame: { x: 1400, y: 100, w: 500, h: 200 } }),
  block({ key: 'lines', type: 'lines', overflow: 'grow', frame: { x: 200, y: 1100, w: 1700, h: 0 } }),
  block({ key: 'totals', type: 'totals', frame: { x: 1000, y: 1400, w: 900, h: 0 }, anchor: { to: 'lines', gap: 35 } }),
  block({ key: 'notes', type: 'notes', frame: { x: 200, y: 1500, w: 1700, h: 0 }, anchor: { to: 'totals', gap: 20 } }),
  block({ key: 'payment', type: 'payment', frame: { x: 200, y: 1600, w: 1700, h: 0 }, anchor: { to: 'notes', gap: 20 } }),
];
const boxes: BlockBox[] = [
  { key: 'logo', page: 1, x: 1400, y: 100, w: 500, h: 200 },
  { key: 'lines', page: 1, x: 200, y: 1100, w: 1700, h: 1700 },
  { key: 'lines', page: 2, x: 200, y: 170, w: 1700, h: 600 },
  { key: 'totals', page: 2, x: 1000, y: 805, w: 900, h: 300 },
];
const layout = { blocks } as never;
const flow = flowBlocks(layout);
const byKey = new Map(blocks.map((b) => [b.key, b]));
const rect = (key: string, page: number) => displayRect(byKey.get(key)!, boxes, page, 2, flow, byKey);

describe('layout overlay', () => {
  it('draws a flow block only on the pages it is printed on', () => {
    expect(rect('totals', 1)).toBeUndefined();
    expect(rect('totals', 2)).toEqual({ x: 1000, y: 805, w: 900, h: 300 });
    expect(rect('lines', 1)).toMatchObject({ y: 1100, h: 1700 });
    expect(rect('lines', 2)).toMatchObject({ y: 170, h: 600 });
  });

  it('draws empty flow blocks below the block they follow, on its last page', () => {
    expect(rect('notes', 1)).toBeUndefined();
    expect(rect('notes', 2)).toEqual({ x: 200, y: 805 + 300 + 20, w: 1700, h: 30 });
    expect(rect('payment', 2)).toEqual({ x: 200, y: 1125 + 30 + 20, w: 1700, h: 30 });
  });

  it('draws fixed blocks at their frame on the pages they print on', () => {
    expect(rect('logo', 1)).toEqual({ x: 1400, y: 100, w: 500, h: 200 });
    expect(rect('logo', 2)).toBeUndefined();
  });
});
