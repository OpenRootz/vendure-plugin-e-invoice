/**
 * The layout document as the editor sees it (mirrors `PdfLayoutV2` of the plugin core; the server validates every
 * layout again, so this file only needs what the editor displays and edits). Units are 0.1 mm.
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

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Block {
  key: string;
  type: BlockType;
  visible: boolean;
  pages: 'first' | 'all' | 'following' | 'last';
  frame: Frame;
  anchor?: { to: string; gap: number };
  overflow: 'grow' | 'fixed';
  style?: { fontSize?: number; bold?: boolean; align?: 'left' | 'center' | 'right'; color?: string };
  props?: Record<string, unknown>;
}

export interface LayoutDocument {
  version: 2;
  page: { size: 'A4'; margins: [number, number, number, number] };
  continuation: { top: number; bottom: number };
  theme: { accentColor: string; font?: string; fontSize: number };
  windowEnvelope?: 'A' | 'B';
  blocks: Block[];
}

export interface BlockBox {
  key: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  overflowBy?: number | null;
}

export interface LayoutIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  blockKey?: string | null;
}

export const PAGE = { w: 2100, h: 2970 };

export const BLOCK_LABELS: Record<BlockType, string> = {
  logo: 'Logo',
  senderLine: 'Sender line',
  recipient: 'Recipient',
  details: 'Invoice details',
  title: 'Title',
  deliveryAddress: 'Delivery address',
  introText: 'Intro text',
  lines: 'Line items',
  totals: 'Totals',
  exemptionNotes: 'VAT exemption notes',
  notes: 'Notes',
  payment: 'Payment',
  closingText: 'Closing text',
  footer: 'Footer',
  pageNumber: 'Page number',
  customText: 'Custom text',
  image: 'Image',
};

export const DETAIL_FIELDS = ['number', 'issueDate', 'deliveryDate', 'orderNumber', 'purchaseOrder', 'buyerReference', 'buyerVatId', 'sellerTaxId'] as const;
export type DetailField = (typeof DETAIL_FIELDS)[number];
export const DETAIL_LABELS: Record<DetailField, string> = {
  number: 'Invoice number',
  issueDate: 'Invoice date',
  deliveryDate: 'Delivery date',
  orderNumber: 'Order number',
  purchaseOrder: 'Purchase order',
  buyerReference: 'Buyer reference',
  buyerVatId: 'Buyer VAT ID',
  sellerTaxId: 'Seller VAT ID / tax number',
};
const DEFAULT_DETAIL_FIELDS: DetailField[] = DETAIL_FIELDS.filter((f) => f !== 'sellerTaxId');
export const detailFields = (b: Block): DetailField[] => (Array.isArray(b.props?.fields) ? (b.props.fields as DetailField[]) : DEFAULT_DETAIL_FIELDS);

/** Content §14 UStG requires and the blocks that print it (same rules as the server's coverage check). */
export const MANDATORY: { field: string; label: string }[] = [
  { field: 'sellerAddress', label: 'Seller name and address' },
  { field: 'sellerTaxId', label: 'Seller VAT ID or tax number' },
  { field: 'buyerAddress', label: 'Buyer name and address' },
  { field: 'number', label: 'Invoice number' },
  { field: 'issueDate', label: 'Invoice date' },
  { field: 'deliveryDate', label: 'Delivery date' },
  { field: 'lines', label: 'Goods and services' },
  { field: 'vatBreakdown', label: 'VAT breakdown and totals' },
  { field: 'exemption', label: 'VAT exemption note' },
];

export function blockCoverage(b: Block): string[] {
  switch (b.type) {
    case 'senderLine':
      return ['sellerAddress'];
    case 'footer':
      return ['sellerAddress', 'sellerTaxId'];
    case 'recipient':
      return ['buyerAddress'];
    case 'title':
      return ['number'];
    case 'lines':
      return ['lines'];
    case 'totals':
      return ['vatBreakdown'];
    case 'exemptionNotes':
      return ['exemption'];
    case 'details': {
      const map: Partial<Record<DetailField, string>> = { number: 'number', issueDate: 'issueDate', deliveryDate: 'deliveryDate', sellerTaxId: 'sellerTaxId' };
      return detailFields(b)
        .map((f) => map[f])
        .filter((f): f is string => !!f);
    }
    default:
      return [];
  }
}

/** Mandatory fields for which `block` is the last visible block printing them (it must not be hidden). */
export function lastCarrierOf(layout: LayoutDocument, block: Block): string[] {
  return blockCoverage(block).filter((field) => !layout.blocks.some((b) => b.key !== block.key && b.visible && blockCoverage(b).includes(field)));
}

export const mm = (tenth: number) => Math.round(tenth) / 10;
export const fromMm = (value: number) => Math.round(value * 10);

/** Whether a fixed block is printed on the given page (flow blocks appear where their content is measured). */
export function onPage(b: Block, page: number, pageCount: number) {
  return b.pages === 'all' || (b.pages === 'first' && page === 1) || (b.pages === 'following' && page > 1) || (b.pages === 'last' && page === pageCount);
}

/** True if `target` is (transitively) anchored to `block`, so anchoring `block` to it would form a cycle. */
export function dependsOn(layout: LayoutDocument, target: string, block: string): boolean {
  const byKey = new Map(layout.blocks.map((b) => [b.key, b]));
  let cur = byKey.get(target);
  for (let i = 0; cur && i <= layout.blocks.length; i++) {
    if (cur.key === block) return true;
    cur = cur.anchor ? byKey.get(cur.anchor.to) : undefined;
  }
  return false;
}

export function updateBlock(layout: LayoutDocument, key: string, change: Partial<Block> | ((b: Block) => Block)): LayoutDocument {
  return {
    ...layout,
    blocks: layout.blocks.map((b) => (b.key === key ? (typeof change === 'function' ? change(b) : { ...b, ...change }) : b)),
  };
}

/** Removes a block; blocks anchored to it take over its anchor. */
export function removeBlock(layout: LayoutDocument, key: string): LayoutDocument {
  const removed = layout.blocks.find((b) => b.key === key);
  return {
    ...layout,
    blocks: layout.blocks
      .filter((b) => b.key !== key)
      .map((b) => (b.anchor?.to === key ? { ...b, anchor: removed?.anchor ? { ...removed.anchor } : undefined, frame: { ...b.frame } } : b)),
  };
}

export function newBlockKey(layout: LayoutDocument, type: BlockType): string {
  let i = 1;
  while (layout.blocks.some((b) => b.key === `${type}${i}`)) i++;
  return `${type}${i}`;
}
