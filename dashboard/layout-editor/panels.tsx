import { api, Button, Input, Label, Textarea, useQuery } from '@vendure/dashboard';
import { ReactNode } from 'react';

import { layoutFontsDocument } from '../graphql';

import {
  Block,
  BLOCK_LABELS,
  blockCoverage,
  DETAIL_FIELDS,
  DETAIL_LABELS,
  detailFields,
  DetailField,
  dependsOn,
  fromMm,
  lastCarrierOf,
  LayoutDocument,
  LayoutIssue,
  MANDATORY,
  mm,
  updateBlock,
} from './model';

const selectClass = 'h-8 w-full rounded-md border bg-background px-2 text-sm';
const label = (field: string) => MANDATORY.find((m) => m.field === field)?.label ?? field;

function Row({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** A number input in mm for a value stored in 0.1 mm. */
function MmInput({ id, value, onChange, min }: { id: string; value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <Input
      id={id}
      type="number"
      step={0.1}
      min={min}
      value={mm(value)}
      className="h-8"
      onChange={(e) => {
        if (e.target.value === '') return;
        const v = fromMm(Number(e.target.value));
        if (Number.isFinite(v)) onChange(min !== undefined ? Math.max(fromMm(min), v) : v);
      }}
    />
  );
}

/** Left panel: all blocks with visibility, lock, mandatory-content badges and the anchor chain. */
export function BlockList({
  layout,
  selected,
  locked,
  issues,
  onSelect,
  onChange,
  onToggleLock,
  onAdd,
}: {
  layout: LayoutDocument;
  selected?: string;
  locked: Set<string>;
  issues: LayoutIssue[];
  onSelect: (key: string) => void;
  onChange: (layout: LayoutDocument) => void;
  onToggleLock: (key: string) => void;
  onAdd: (type: 'customText' | 'image' | 'pageNumber') => void;
}) {
  return (
    <div className="space-y-2">
      <ul className="space-y-1" aria-label="Blocks">
        {layout.blocks.map((b) => {
          const carrierOf = lastCarrierOf(layout, b);
          const fields = blockCoverage(b);
          const issue = issues.find((i) => i.blockKey === b.key);
          return (
            <li
              key={b.key}
              className={`flex items-center gap-2 rounded px-2 py-1 text-sm ${b.key === selected ? 'bg-accent' : 'hover:bg-muted'}`}
            >
              <input
                type="checkbox"
                aria-label={`Show ${BLOCK_LABELS[b.type]}`}
                checked={b.visible}
                disabled={b.visible && carrierOf.length > 0}
                title={b.visible && carrierOf.length ? `Last block printing: ${carrierOf.map(label).join(', ')}` : 'Visible'}
                onChange={(e) => onChange(updateBlock(layout, b.key, { visible: e.target.checked }))}
              />
              <button type="button" className="flex-1 truncate text-left" onClick={() => onSelect(b.key)}>
                {BLOCK_LABELS[b.type]}
                {b.anchor && <span title={`Follows ${b.anchor.to}`}> 🔗</span>}
                {issue && <span className={issue.level === 'error' ? 'text-destructive' : 'text-amber-600'}> ●</span>}
              </button>
              {fields.length > 0 && (
                <span
                  className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground"
                  title={`Mandatory content (§14 UStG): ${fields.map(label).join(', ')}`}
                >
                  §14
                </span>
              )}
              <button
                type="button"
                className="text-xs"
                title={locked.has(b.key) ? 'Unlock' : 'Lock against moving (only while this page is open; not saved)'}
                onClick={() => onToggleLock(b.key)}
              >
                {locked.has(b.key) ? '🔒' : '🔓'}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" onClick={() => onAdd('customText')}>
          + Text
        </Button>
        <Button size="sm" variant="outline" onClick={() => onAdd('image')}>
          + Image
        </Button>
        <Button size="sm" variant="outline" onClick={() => onAdd('pageNumber')}>
          + Page number
        </Button>
      </div>
    </div>
  );
}

/** Right panel: the properties of the selected block, or of the page and theme when nothing is selected. */
export function Properties({
  layout,
  block,
  onChange,
  onRemove,
  onPickImage,
  logo,
}: {
  layout: LayoutDocument;
  block?: Block;
  onChange: (layout: LayoutDocument) => void;
  onRemove: (key: string) => void;
  /** Opens the asset picker for the logo (block undefined) or an image block */
  onPickImage: (blockKey?: string) => void;
  logo: ReactNode;
}) {
  if (!block) return <PageProperties layout={layout} onChange={onChange} />;
  const id = (name: string) => `e-invoice-block-${block.key}-${name}`;
  const set = (change: Partial<Block>) => onChange(updateBlock(layout, block.key, change));
  const setFrame = (k: 'x' | 'y' | 'w' | 'h', v: number) => set({ frame: { ...block.frame, [k]: v } });
  const setStyle = (change: Block['style']) => {
    const style = Object.fromEntries(Object.entries({ ...block.style, ...change }).filter(([, v]) => v !== undefined && v !== ''));
    set({ style: Object.keys(style).length ? style : undefined });
  };
  const setProp = (k: string, v: unknown) => {
    const props = Object.fromEntries(Object.entries({ ...block.props, [k]: v }).filter(([, x]) => x !== undefined && x !== ''));
    set({ props: Object.keys(props).length ? props : undefined });
  };
  const anchorTargets = layout.blocks.filter(
    (b) => b.key !== block.key && !dependsOn(layout, b.key, block.key) && !layout.blocks.some((o) => o.anchor?.to === b.key && o.key !== block.key),
  );
  const text = typeof block.props?.text === 'string' ? block.props.text : '';
  const removable = block.type === 'customText' || block.type === 'image' || block.type === 'pageNumber';

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{BLOCK_LABELS[block.type]}</h3>
        <span className="font-mono text-xs text-muted-foreground">{block.key}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Row label="x (mm)" htmlFor={id('x')}>
          <MmInput id={id('x')} value={block.frame.x} onChange={(v) => setFrame('x', v)} />
        </Row>
        <Row label="y (mm)" htmlFor={id('y')}>
          <MmInput id={id('y')} value={block.frame.y} onChange={(v) => set({ frame: { ...block.frame, y: v }, anchor: undefined })} />
        </Row>
        <Row label="Width (mm)" htmlFor={id('w')}>
          <MmInput id={id('w')} value={block.frame.w} min={0.1} onChange={(v) => setFrame('w', v)} />
        </Row>
        <Row label={block.overflow === 'grow' ? 'Min. height (mm)' : 'Height (mm)'} htmlFor={id('h')}>
          <MmInput id={id('h')} value={block.frame.h} min={block.overflow === 'fixed' ? 0.1 : 0} onChange={(v) => setFrame('h', v)} />
        </Row>
      </div>
      <Row label="Size" htmlFor={id('overflow')}>
        <select
          id={id('overflow')}
          className={selectClass}
          value={block.overflow}
          onChange={(e) => set({ overflow: e.target.value as Block['overflow'], frame: { ...block.frame, h: Math.max(block.frame.h, e.target.value === 'fixed' ? 100 : 0) } })}
        >
          <option value="grow">Grows with its content (continues on the next page)</option>
          <option value="fixed">Fixed frame</option>
        </select>
      </Row>
      <Row label="Placed below" htmlFor={id('anchor')}>
        <div className="flex gap-2">
          <select
            id={id('anchor')}
            className={selectClass}
            value={block.anchor?.to ?? ''}
            onChange={(e) => set({ anchor: e.target.value ? { to: e.target.value, gap: block.anchor?.gap ?? 30 } : undefined })}
          >
            <option value="">— its own position —</option>
            {anchorTargets.map((b) => (
              <option key={b.key} value={b.key}>
                {BLOCK_LABELS[b.type]} ({b.key})
              </option>
            ))}
          </select>
          {block.anchor && (
            <div className="w-24">
              <MmInput id={id('gap')} value={block.anchor.gap} min={0} onChange={(v) => set({ anchor: { ...block.anchor!, gap: v } })} />
            </div>
          )}
        </div>
      </Row>
      {block.overflow === 'fixed' && !block.anchor && (
        <Row label="Pages" htmlFor={id('pages')}>
          <select id={id('pages')} className={selectClass} value={block.pages} onChange={(e) => set({ pages: e.target.value as Block['pages'] })}>
            <option value="first">First page</option>
            <option value="all">All pages</option>
            <option value="following">Following pages</option>
            <option value="last">Last page</option>
          </select>
        </Row>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Row label="Font size (pt)" htmlFor={id('fontSize')}>
          <Input
            id={id('fontSize')}
            type="number"
            step={0.5}
            min={1}
            className="h-8"
            value={block.style?.fontSize ?? ''}
            placeholder={String(layout.theme.fontSize)}
            onChange={(e) => setStyle({ fontSize: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 2) / 2 })}
          />
        </Row>
        <Row label="Color" htmlFor={id('color')}>
          <Input id={id('color')} className="h-8" placeholder="#333333" value={block.style?.color ?? ''} onChange={(e) => setStyle({ color: e.target.value || undefined })} />
        </Row>
        <Row label="Alignment" htmlFor={id('align')}>
          <select id={id('align')} className={selectClass} value={block.style?.align ?? ''} onChange={(e) => setStyle({ align: (e.target.value || undefined) as never })}>
            <option value="">Default</option>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </Row>
        <label className="flex items-center gap-2 self-end pb-1 text-xs">
          <input type="checkbox" checked={!!block.style?.bold} onChange={(e) => setStyle({ bold: e.target.checked || undefined })} />
          Bold
        </label>
      </div>

      {(block.type === 'introText' || block.type === 'closingText' || block.type === 'customText' || block.type === 'footer') && (
        <Row label={block.type === 'footer' ? 'Additional footer line' : 'Text'} htmlFor={id('text')}>
          <Textarea id={id('text')} maxLength={2000} value={text} onChange={(e) => setProp('text', e.target.value || undefined)} />
          {block.type === 'customText' && (
            <p className="text-xs text-muted-foreground">Placeholders: {'{number}'}, {'{issueDate}'}, {'{orderCode}'}, {'{buyerName}'} (no amounts)</p>
          )}
        </Row>
      )}
      {block.type === 'footer' && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!block.props?.pageNumber} onChange={(e) => setProp('pageNumber', e.target.checked || undefined)} />
          Page number in the footer
        </label>
      )}
      {block.type === 'logo' && logo}
      {block.type === 'image' && (
        <Row label="Image">
          <Button size="sm" variant="outline" onClick={() => onPickImage(block.key)}>
            {block.props?.assetId ? 'Change image' : 'Select image'}
          </Button>
        </Row>
      )}
      {block.type === 'details' && <DetailFields layout={layout} block={block} onChange={(fields) => setProp('fields', fields)} />}
      {block.type === 'lines' && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={(block.props?.columns as { position?: boolean } | undefined)?.position !== false}
            onChange={(e) => setProp('columns', e.target.checked ? undefined : { position: false })}
          />
          Position column
        </label>
      )}
      {removable && (
        <Button size="sm" variant="destructive" onClick={() => onRemove(block.key)}>
          Remove block
        </Button>
      )}
    </div>
  );
}

/** Detail rows that print mandatory content (§14 UStG). */
const MANDATORY_ROWS: Partial<Record<DetailField, string>> = { number: 'number', issueDate: 'issueDate', deliveryDate: 'deliveryDate', sellerTaxId: 'sellerTaxId' };

function DetailFields({ layout, block, onChange }: { layout: LayoutDocument; block: Block; onChange: (fields: DetailField[]) => void }) {
  const fields = detailFields(block);
  // Rows this block is the last visible carrier of cannot be removed (the layout could not be saved)
  const lastCarrier = block.visible ? lastCarrierOf(layout, block) : [];
  const required = (f: DetailField) => !!MANDATORY_ROWS[f] && lastCarrier.includes(MANDATORY_ROWS[f]!);
  const move = (i: number, d: -1 | 1) => {
    const next = [...fields];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-1">
      <Label className="text-xs">Rows</Label>
      {fields.map((f, i) => (
        <div key={f} className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked
            disabled={required(f)}
            title={required(f) ? 'Mandatory content (§14 UStG) that no other visible block prints' : undefined}
            onChange={() => onChange(fields.filter((x) => x !== f))}
          />
          <span className="flex-1">
            {DETAIL_LABELS[f]}
            {required(f) && <span className="ml-1 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">§14</span>}
          </span>
          <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Up">
            ↑
          </button>
          <button type="button" disabled={i === fields.length - 1} onClick={() => move(i, 1)} aria-label="Down">
            ↓
          </button>
        </div>
      ))}
      {DETAIL_FIELDS.filter((f) => !fields.includes(f)).map((f) => (
        <label key={f} className="flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={false} onChange={() => onChange([...fields, f])} />
          {DETAIL_LABELS[f]}
        </label>
      ))}
    </div>
  );
}

function PageProperties({ layout, onChange }: { layout: LayoutDocument; onChange: (layout: LayoutDocument) => void }) {
  const theme = (change: Partial<LayoutDocument['theme']>) => onChange({ ...layout, theme: { ...layout.theme, ...change } });
  const fonts = useQuery({ queryKey: ['e-invoice-layout-fonts'], queryFn: () => api.query(layoutFontsDocument), staleTime: Infinity }).data?.eInvoiceLayoutFonts ?? [];
  const font = layout.theme.font;
  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">Page and theme</h3>
      <Row label="Accent color" htmlFor="e-invoice-theme-accent">
        <div className="flex gap-2">
          <input
            type="color"
            aria-label="Pick the accent color"
            value={/^#[0-9a-f]{6}$/i.test(layout.theme.accentColor) ? layout.theme.accentColor : '#333333'}
            onChange={(e) => theme({ accentColor: e.target.value })}
          />
          <Input id="e-invoice-theme-accent" className="h-8" value={layout.theme.accentColor} onChange={(e) => theme({ accentColor: e.target.value })} />
        </div>
      </Row>
      <Row label="Font size (pt)" htmlFor="e-invoice-theme-size">
        <Input
          id="e-invoice-theme-size"
          type="number"
          step={0.5}
          min={6}
          max={36}
          className="h-8"
          value={layout.theme.fontSize}
          onChange={(e) => e.target.value && theme({ fontSize: Math.round(Number(e.target.value) * 2) / 2 })}
        />
      </Row>
      <Row label="Font" htmlFor="e-invoice-theme-font">
        <select id="e-invoice-theme-font" className={selectClass} value={font ?? ''} onChange={(e) => theme({ font: e.target.value || undefined })}>
          <option value="">Default{fonts[0] ? ` (${fonts[0]})` : ''}</option>
          {fonts.slice(1).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          {font && !fonts.includes(font) && <option value={font}>{font} (not configured)</option>}
        </select>
        <p className="text-xs text-muted-foreground">More fonts: plugin option pdf.fonts (TTF files)</p>
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label="Flow starts on following pages (mm)" htmlFor="e-invoice-cont-top">
          <MmInput id="e-invoice-cont-top" value={layout.continuation.top} min={0} onChange={(v) => onChange({ ...layout, continuation: { ...layout.continuation, top: v } })} />
        </Row>
        <Row label="Flow ends above the bottom (mm)" htmlFor="e-invoice-cont-bottom">
          <MmInput id="e-invoice-cont-bottom" value={layout.continuation.bottom} min={0} onChange={(v) => onChange({ ...layout, continuation: { ...layout.continuation, bottom: v } })} />
        </Row>
      </div>
      <Row label="Window envelope check (DIN 5008)" htmlFor="e-invoice-window">
        <select
          id="e-invoice-window"
          className={selectClass}
          value={layout.windowEnvelope ?? ''}
          onChange={(e) => onChange({ ...layout, windowEnvelope: (e.target.value || undefined) as LayoutDocument['windowEnvelope'] })}
        >
          <option value="">Off</option>
          <option value="A">Form A (window at 27 mm)</option>
          <option value="B">Form B (window at 45 mm)</option>
        </select>
      </Row>
      <p className="text-xs text-muted-foreground">Select a block on the page or in the list to edit it. Shift while dragging turns snapping off.</p>
    </div>
  );
}
