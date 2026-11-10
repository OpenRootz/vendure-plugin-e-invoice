/**
 * Layout model v2: the PDF layout as data. Every block has a free frame on the page; `grow` blocks take as much
 * height as their content needs and continue on the next page, `fixed` blocks keep their frame. Anchors chain
 * blocks below each other (e.g. totals below the line table), so they move with content of unknown length.
 *
 * All positions and sizes are integer tenths of a millimetre (`0.1 mm`), so stored layouts contain no floats;
 * they are converted to PDF points only when rendering.
 */

export type BlockType =
  | 'logo'
  | 'senderLine'
  | 'recipient'
  | 'details'
  | 'title'
  | 'deliveryAddress'
  | 'introText'
  | 'lines'
  | 'totals'
  | 'exemptionNotes'
  | 'notes'
  | 'payment'
  | 'closingText'
  | 'footer'
  | 'pageNumber'
  | 'customText'
  | 'image';

export const BLOCK_TYPES: BlockType[] = [
  'logo',
  'senderLine',
  'recipient',
  'details',
  'title',
  'deliveryAddress',
  'introText',
  'lines',
  'totals',
  'exemptionNotes',
  'notes',
  'payment',
  'closingText',
  'footer',
  'pageNumber',
  'customText',
  'image',
];

/** On which pages a fixed block is printed. Blocks in the flow appear where their content ends up. */
export type BlockPages = 'first' | 'all' | 'following' | 'last';

export interface BlockFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlockStyle {
  /** pt */
  fontSize?: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Hex color `#rrggbb` */
  color?: string;
}

export interface LayoutBlock {
  /** Stable and unique within the layout (named `key`, as the Vendure API encodes `id` fields) */
  key: string;
  type: BlockType;
  visible: boolean;
  pages: BlockPages;
  /** Position on the block's first page; `h` is the minimum height of `grow` blocks */
  frame: BlockFrame;
  /** Place the block below another one: y = bottom of `to` + `gap` (instead of `frame.y`) */
  anchor?: { to: string; gap: number };
  overflow: 'grow' | 'fixed';
  style?: BlockStyle;
  /** Type-specific settings, see {@link BlockProps} */
  props?: Record<string, unknown>;
}

/** Props per block type (all optional). */
export interface BlockProps {
  introText: { text?: string };
  closingText: { text?: string };
  footer: { text?: string; pageNumber?: boolean };
  customText: { text?: string };
  image: { assetId?: string };
  details: { fields?: DetailField[] };
  lines: { columns?: { position?: boolean; widths?: Partial<Record<LineColumn, number>> } };
}

export type DetailField =
  'number' | 'issueDate' | 'deliveryDate' | 'orderNumber' | 'purchaseOrder' | 'buyerReference' | 'buyerVatId' | 'sellerTaxId';
export const DETAIL_FIELDS: DetailField[] = [
  'number',
  'issueDate',
  'deliveryDate',
  'orderNumber',
  'purchaseOrder',
  'buyerReference',
  'buyerVatId',
  'sellerTaxId',
];
export type LineColumn = 'position' | 'quantity' | 'unitPrice' | 'vatRate' | 'amount';

export interface PdfLayoutV2 {
  version: 2;
  /** Page size and the guide margins `[top, right, bottom, left]` */
  page: { size: 'A4'; margins: [number, number, number, number] };
  /** Flow area: where flowing content starts on following pages and where it ends on every page */
  continuation: { top: number; bottom: number };
  /** `font` = a family of `pdf.fonts`; `fontSize` in pt */
  theme: { accentColor: string; font?: string; fontSize: number };
  /** Opt-in check that the recipient is inside the window of a DIN 5008 envelope */
  windowEnvelope?: 'A' | 'B';
  blocks: LayoutBlock[];
}

/** The v1 settings: logo, accent color and three texts. */
export interface PdfLayout {
  /** Hex color for the title, table header and lines, e.g. `#1a5fb4` */
  accentColor?: string;
  /** Text above the line table */
  introText?: string;
  /** Text below the payment information */
  closingText?: string;
  /** Additional footer line */
  footerText?: string;
}

export const PAGE_SIZES = { A4: { w: 2100, h: 2970 } } as const;

/** 0.1 mm → pt */
export const toPt = (tenthMm: number) => (tenthMm * 72) / 254;
/** pt → 0.1 mm (rounded) */
export const fromPt = (pt: number) => Math.round((pt * 254) / 72);

export const MAX_BLOCKS = 50;
export const MAX_TEXT = 2000;
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 36;
export const DEFAULT_ACCENT = '#333333';

const block = (b: Omit<LayoutBlock, 'visible' | 'pages' | 'overflow'> & Partial<LayoutBlock>): LayoutBlock => ({
  visible: true,
  pages: 'first',
  overflow: 'grow',
  ...b,
});

/**
 * Today's look as data: logo top right, sender line and recipient in the address window, invoice details beside
 * it, then the flowing part (title, texts, line table, totals, payment) and the footer on every page.
 */
export function defaultLayout(v1: PdfLayout = {}): PdfLayoutV2 {
  return {
    version: 2,
    page: { size: 'A4', margins: [169, 198, 339, 198] },
    continuation: { top: 169, bottom: 339 },
    theme: { accentColor: validColor(v1.accentColor) ? v1.accentColor! : DEFAULT_ACCENT, fontSize: 9 },
    blocks: [
      block({ key: 'logo', type: 'logo', frame: { x: 1337, y: 169, w: 564, h: 212 }, overflow: 'fixed', style: { align: 'right' } }),
      block({
        key: 'senderLine',
        type: 'senderLine',
        frame: { x: 198, y: 423, w: 878, h: 39 },
        overflow: 'fixed',
        style: { fontSize: 7, color: '#555555' },
      }),
      block({ key: 'recipient', type: 'recipient', frame: { x: 198, y: 478, w: 878, h: 370 }, overflow: 'fixed' }),
      block({ key: 'details', type: 'details', frame: { x: 1161, y: 423, w: 741, h: 425 }, overflow: 'fixed' }),
      block({ key: 'deliveryAddress', type: 'deliveryAddress', frame: { x: 198, y: 848, w: 1704, h: 0 } }),
      block({ key: 'title', type: 'title', frame: { x: 198, y: 933, w: 1704, h: 0 }, anchor: { to: 'deliveryAddress', gap: 85 } }),
      block({
        key: 'introText',
        type: 'introText',
        frame: { x: 198, y: 1000, w: 1704, h: 0 },
        anchor: { to: 'title', gap: 28 },
        props: textProp(v1.introText),
      }),
      block({ key: 'lines', type: 'lines', frame: { x: 198, y: 1100, w: 1704, h: 0 }, anchor: { to: 'introText', gap: 49 } }),
      block({ key: 'totals', type: 'totals', frame: { x: 1055, y: 1400, w: 847, h: 0 }, anchor: { to: 'lines', gap: 35 } }),
      block({
        key: 'exemptionNotes',
        type: 'exemptionNotes',
        frame: { x: 198, y: 1600, w: 1704, h: 0 },
        anchor: { to: 'totals', gap: 35 },
      }),
      block({ key: 'notes', type: 'notes', frame: { x: 198, y: 1650, w: 1704, h: 0 }, anchor: { to: 'exemptionNotes', gap: 28 } }),
      block({ key: 'payment', type: 'payment', frame: { x: 198, y: 1700, w: 1704, h: 0 }, anchor: { to: 'notes', gap: 56 } }),
      block({
        key: 'closingText',
        type: 'closingText',
        frame: { x: 198, y: 1850, w: 1704, h: 0 },
        anchor: { to: 'payment', gap: 42 },
        props: textProp(v1.closingText),
      }),
      block({
        key: 'footer',
        type: 'footer',
        frame: { x: 198, y: 2640, w: 1704, h: 280 },
        overflow: 'fixed',
        pages: 'all',
        style: { fontSize: 7, color: '#555555' },
        props: { ...textProp(v1.footerText), pageNumber: true },
      }),
    ],
  };
}

const textProp = (text?: string) => (text ? { text } : {});

/** Converts the v1 settings (accent color and texts) into a v2 layout. */
export function layoutFromV1(v1: PdfLayout): PdfLayoutV2 {
  return defaultLayout(v1);
}

export const isLayoutV2 = (layout: unknown): layout is PdfLayoutV2 =>
  !!layout && typeof layout === 'object' && (layout as { version?: unknown }).version === 2;

export const validColor = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/** Applies the v1 fields as shortcuts to a v2 layout (theme color and the text props of the text blocks). */
export function patchLayout(layout: PdfLayoutV2, v1: PdfLayout): PdfLayoutV2 {
  const copy: PdfLayoutV2 = structuredClone(layout);
  if (v1.accentColor !== undefined) copy.theme.accentColor = v1.accentColor;
  const setText = (type: BlockType, text: string | undefined) => {
    if (text === undefined) return;
    for (const b of copy.blocks.filter((x) => x.type === type)) b.props = { ...b.props, text: text || undefined };
  };
  setText('introText', v1.introText);
  setText('closingText', v1.closingText);
  setText('footer', v1.footerText);
  return copy;
}

/** The v1 fields of a v2 layout (for the deprecated API fields). */
export function v1Fields(layout: PdfLayoutV2): Required<PdfLayout> {
  const text = (type: BlockType) => {
    const t = layout.blocks.find((b) => b.type === type)?.props?.text;
    return typeof t === 'string' ? t : '';
  };
  return {
    accentColor: layout.theme.accentColor,
    introText: text('introText'),
    closingText: text('closingText'),
    footerText: text('footer'),
  };
}

// --- parsing / structural validation ---

export interface LayoutIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  blockKey?: string;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const ALLOWED_PROPS: Record<BlockType, Record<string, (v: unknown) => boolean>> = {
  logo: {},
  senderLine: {},
  recipient: {},
  details: {
    fields: (v) => Array.isArray(v) && v.every((f) => DETAIL_FIELDS.includes(f as DetailField)) && new Set(v).size === v.length,
  },
  title: {},
  deliveryAddress: {},
  introText: { text: (v) => typeof v === 'string' },
  lines: {
    columns: (v) =>
      isObj(v) &&
      Object.keys(v).every((k) => k === 'position' || k === 'widths') &&
      (v.position === undefined || typeof v.position === 'boolean') &&
      (v.widths === undefined ||
        (isObj(v.widths) &&
          Object.entries(v.widths).every(
            ([k, w]) => ['position', 'quantity', 'unitPrice', 'vatRate', 'amount'].includes(k) && isInt(w) && w >= 50 && w <= 1000,
          ))),
  },
  totals: {},
  exemptionNotes: {},
  notes: {},
  payment: {},
  closingText: { text: (v) => typeof v === 'string' },
  footer: { text: (v) => typeof v === 'string', pageNumber: (v) => typeof v === 'boolean' },
  pageNumber: {},
  customText: { text: (v) => typeof v === 'string' },
  image: { assetId: (v) => (typeof v === 'string' || typeof v === 'number') && String(v).length > 0 },
};

/**
 * Parses and structurally validates a layout (e.g. from the API). Returns the layout and the structural errors:
 * unknown types or props, invalid frames, duplicate ids, anchors to missing blocks, anchor cycles and branches,
 * too many blocks, too long texts.
 */
export function parseLayout(input: unknown): { layout?: PdfLayoutV2; issues: LayoutIssue[] } {
  const issues: LayoutIssue[] = [];
  const error = (code: string, message: string, blockKey?: string) => issues.push({ level: 'error', code, message, blockKey });
  if (!isObj(input) || input.version !== 2) {
    error('INVALID_LAYOUT', 'The layout must be an object with version 2');
    return { issues };
  }
  const page = input.page;
  const size = isObj(page) && page.size === 'A4' ? PAGE_SIZES.A4 : undefined;
  if (!size) error('INVALID_LAYOUT', 'page.size must be A4');
  const margins = isObj(page) ? page.margins : undefined;
  if (!Array.isArray(margins) || margins.length !== 4 || !margins.every((m) => isInt(m) && m >= 0 && m <= 1000)) {
    error('INVALID_LAYOUT', 'page.margins must be four integers (0.1 mm) between 0 and 1000');
  }
  const cont = input.continuation;
  if (!isObj(cont) || !isInt(cont.top) || !isInt(cont.bottom) || cont.top < 0 || cont.bottom < 0 || cont.top + cont.bottom > 2500) {
    error(
      'INVALID_LAYOUT',
      'continuation.top and continuation.bottom must be integers (0.1 mm); the flow area must stay at least 4.7 cm high',
    );
  }
  const theme = input.theme;
  if (!isObj(theme) || !validColor(theme.accentColor)) error('INVALID_LAYOUT', 'theme.accentColor must be a hex color like #1a5fb4');
  if (
    isObj(theme) &&
    (typeof theme.fontSize !== 'number' ||
      theme.fontSize < MIN_FONT_SIZE ||
      theme.fontSize > MAX_FONT_SIZE ||
      (theme.fontSize * 2) % 1 !== 0)
  ) {
    error('INVALID_LAYOUT', `theme.fontSize must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE} pt in steps of 0.5`);
  }
  if (isObj(theme) && theme.font !== undefined && (typeof theme.font !== 'string' || !theme.font))
    error('INVALID_LAYOUT', 'theme.font must be a font family name');
  if (input.windowEnvelope !== undefined && input.windowEnvelope !== 'A' && input.windowEnvelope !== 'B') {
    error('INVALID_LAYOUT', 'windowEnvelope must be A or B');
  }
  const known = new Set(['version', 'page', 'continuation', 'theme', 'windowEnvelope', 'blocks', 'logoAssetId']);
  for (const key of Object.keys(input)) if (!known.has(key)) error('UNKNOWN_PROPERTY', `Unknown layout property "${key}"`);

  if (!Array.isArray(input.blocks)) {
    error('INVALID_LAYOUT', 'blocks must be a list');
    return { issues };
  }
  if (input.blocks.length > MAX_BLOCKS) error('TOO_MANY_BLOCKS', `A layout can have at most ${MAX_BLOCKS} blocks`);
  const ids = new Set<string>();
  for (const [i, raw] of input.blocks.entries()) {
    const label = isObj(raw) && typeof raw.key === 'string' ? raw.key : `#${i + 1}`;
    if (!isObj(raw)) {
      error('INVALID_BLOCK', `Block ${label} must be an object`);
      continue;
    }
    const id = raw.key;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id))
      error('INVALID_BLOCK', `Block ${label}: key must be 1–40 letters, digits, - or _`);
    else if (ids.has(id)) error('DUPLICATE_KEY', `Block key "${id}" is used twice`, id);
    else ids.add(id);
    const blockKey = typeof id === 'string' ? id : undefined;
    const type = raw.type as BlockType;
    if (!BLOCK_TYPES.includes(type)) {
      error('UNKNOWN_BLOCK_TYPE', `Block ${label}: unknown type "${String(raw.type)}"`, blockKey);
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!['key', 'type', 'visible', 'pages', 'frame', 'anchor', 'overflow', 'style', 'props'].includes(key)) {
        error('UNKNOWN_PROPERTY', `Block ${label}: unknown property "${key}"`, blockKey);
      }
    }
    if (typeof raw.visible !== 'boolean') error('INVALID_BLOCK', `Block ${label}: visible must be true or false`, blockKey);
    if (!['first', 'all', 'following', 'last'].includes(raw.pages as string))
      error('INVALID_BLOCK', `Block ${label}: pages must be first, all, following or last`, blockKey);
    if (raw.overflow !== 'grow' && raw.overflow !== 'fixed')
      error('INVALID_BLOCK', `Block ${label}: overflow must be grow or fixed`, blockKey);
    const f = raw.frame;
    if (
      !isObj(f) ||
      ![f.x, f.y, f.w, f.h].every(isInt) ||
      (f.w as number) < 1 ||
      (f.h as number) < 0 ||
      (f.x as number) < -1000 ||
      (f.y as number) < -1000 ||
      (f.x as number) > 5000 ||
      (f.y as number) > 5000 ||
      (f.w as number) > 5000 ||
      (f.h as number) > 5000
    ) {
      error('INVALID_FRAME', `Block ${label}: frame must have integer x, y, w (≥ 1) and h (≥ 0) in 0.1 mm`, blockKey);
    } else if (raw.overflow === 'fixed' && (f.h as number) < 1) {
      error('INVALID_FRAME', `Block ${label}: a fixed block needs a height`, blockKey);
    }
    if (raw.anchor !== undefined) {
      const a = raw.anchor;
      if (!isObj(a) || typeof a.to !== 'string' || !isInt(a.gap) || (a.gap as number) < 0 || (a.gap as number) > 3000) {
        error('INVALID_ANCHOR', `Block ${label}: anchor must be { to: block key, gap: integer ≥ 0 }`, blockKey);
      }
    }
    if (raw.style !== undefined) {
      const s = raw.style;
      const ok =
        isObj(s) &&
        Object.keys(s).every((k) => ['fontSize', 'bold', 'align', 'color'].includes(k)) &&
        (s.fontSize === undefined ||
          (typeof s.fontSize === 'number' && s.fontSize >= 1 && s.fontSize <= MAX_FONT_SIZE && (s.fontSize * 2) % 1 === 0)) &&
        (s.bold === undefined || typeof s.bold === 'boolean') &&
        (s.align === undefined || ['left', 'center', 'right'].includes(s.align as string)) &&
        (s.color === undefined || validColor(s.color));
      if (!ok)
        error(
          'INVALID_STYLE',
          `Block ${label}: style has invalid values (fontSize in pt, steps of 0.5; align left/center/right; color #rrggbb)`,
          blockKey,
        );
    }
    if (raw.props !== undefined) {
      if (!isObj(raw.props)) error('INVALID_PROPS', `Block ${label}: props must be an object`, blockKey);
      else {
        for (const [key, value] of Object.entries(raw.props)) {
          const check = ALLOWED_PROPS[type][key];
          if (value === undefined || value === null) continue;
          if (!check) error('UNKNOWN_PROPERTY', `Block ${label}: unknown prop "${key}" for ${type}`, blockKey);
          else if (!check(value)) error('INVALID_PROPS', `Block ${label}: invalid value for prop "${key}"`, blockKey);
          if (typeof value === 'string' && value.length > MAX_TEXT)
            error('TEXT_TOO_LONG', `Block ${label}: ${key} is longer than ${MAX_TEXT} characters`, blockKey);
        }
      }
    }
  }
  if (issues.some((i) => i.level === 'error')) return { issues };

  // Null props (cleared fields) mean "not set"; drop them so no consumer sees e.g. `assetId: null`
  const layout = {
    ...input,
    blocks: (input.blocks as LayoutBlock[]).map((b) =>
      b.props ? { ...b, props: Object.fromEntries(Object.entries(b.props).filter(([, v]) => v !== null && v !== undefined)) } : b,
    ),
  } as unknown as PdfLayoutV2;
  issues.push(...checkAnchors(layout));
  return issues.some((i) => i.level === 'error') ? { issues } : { layout, issues };
}

/** Anchors to missing blocks, to themselves, cycles, and two blocks anchored to the same block. */
export function checkAnchors(layout: PdfLayoutV2): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const byId = new Map(layout.blocks.map((b) => [b.key, b]));
  const anchoredTo = new Map<string, string>();
  for (const b of layout.blocks) {
    if (!b.anchor) continue;
    if (b.anchor.to === b.key)
      issues.push({ level: 'error', code: 'ANCHOR_CYCLE', message: `Block ${b.key} is anchored to itself`, blockKey: b.key });
    else if (!byId.has(b.anchor.to))
      issues.push({
        level: 'error',
        code: 'ANCHOR_MISSING',
        message: `Block ${b.key} is anchored to the missing block "${b.anchor.to}"`,
        blockKey: b.key,
      });
    else if (anchoredTo.has(b.anchor.to)) {
      issues.push({
        level: 'error',
        code: 'ANCHOR_BRANCH',
        message: `Blocks ${anchoredTo.get(b.anchor.to)} and ${b.key} are both anchored to ${b.anchor.to}; only one block can follow another`,
        blockKey: b.key,
      });
    } else anchoredTo.set(b.anchor.to, b.key);
  }
  const cycles = new Set<string>();
  for (const b of layout.blocks) {
    const path: string[] = [];
    let cur: LayoutBlock | undefined = b;
    while (cur?.anchor && byId.has(cur.anchor.to) && path.length <= layout.blocks.length) {
      const at = path.indexOf(cur.key);
      if (at >= 0) {
        const members = path.slice(at);
        const key = [...members].sort().join(',');
        if (!cycles.has(key)) {
          cycles.add(key);
          issues.push({
            level: 'error',
            code: 'ANCHOR_CYCLE',
            message: `The anchors of blocks ${members.join(', ')} form a cycle`,
            blockKey: members[0],
          });
        }
        break;
      }
      path.push(cur.key);
      cur = byId.get(cur.anchor.to);
    }
  }
  return issues.filter((issue, i) => issues.findIndex((x) => x.code === issue.code && x.message === issue.message) === i);
}

export type LayoutPreset = 'default' | 'din5008A' | 'din5008B' | 'minimal';
export const LAYOUT_PRESETS: LayoutPreset[] = ['default', 'din5008A', 'din5008B', 'minimal'];

/**
 * Starting points for the editor. The DIN 5008 presets put sender line and recipient into the window of a Form A
 * (window at 27 mm) or Form B (45 mm) envelope and enable the window check.
 */
export function layoutPreset(preset: LayoutPreset, theme?: Partial<PdfLayoutV2['theme']>): PdfLayoutV2 {
  const layout = defaultLayout();
  if (theme) layout.theme = { ...layout.theme, ...theme };
  const set = (id: string, change: Partial<LayoutBlock>) => {
    const b = layout.blocks.find((x) => x.key === id)!;
    Object.assign(b, change);
  };
  if (preset === 'din5008A' || preset === 'din5008B') {
    const top = preset === 'din5008A' ? 270 : 450;
    layout.windowEnvelope = preset === 'din5008A' ? 'A' : 'B';
    set('logo', { frame: preset === 'din5008A' ? { x: 1337, y: 60, w: 564, h: 180 } : { x: 1337, y: 120, w: 564, h: 250 } });
    set('senderLine', { frame: { x: 250, y: top + 10, w: 800, h: 40 } });
    set('recipient', { frame: { x: 250, y: top + 55, w: 800, h: 395 } });
    set('details', { frame: { x: 1150, y: top + 10, w: 752, h: 450 } });
    set('deliveryAddress', { frame: { x: 198, y: top + 480, w: 1704, h: 0 } });
  }
  if (preset === 'minimal') {
    set('senderLine', { visible: false });
    set('logo', { frame: { x: 198, y: 169, w: 564, h: 212 }, style: { align: 'left' } });
    set('details', { props: { fields: ['number', 'issueDate', 'deliveryDate', 'orderNumber'] } });
  }
  return layout;
}
