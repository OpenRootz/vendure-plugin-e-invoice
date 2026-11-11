import { api, AssetPickerDialog, Button, toast, useMutation, useQuery, useQueryClient } from '@vendure/dashboard';
import { KeyboardEvent, useCallback, useMemo, useState } from 'react';

import { errorMessage, UnsavedChangesGuard } from '../common';
import { assetDocument, defaultLayoutDocument, LayoutPresetName, updateSettingsDocument } from '../graphql';
import { DEFAULT_PREVIEW_OPTIONS, PreviewIssues, PreviewOptions, PreviewToolbar, useLayoutPreview } from '../layout-preview';

import { Block, BLOCK_LABELS, LayoutDocument, LayoutIssue, newBlockKey, PAGE, removeBlock, updateBlock } from './model';
import { LayoutOverlay } from './overlay';
import { BlockList, Properties } from './panels';
import { PdfCanvas } from './pdf-canvas';

const HISTORY = 100;
const ZOOMS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6];

interface History {
  past: LayoutDocument[];
  present: LayoutDocument;
  future: LayoutDocument[];
}

const PRESETS: { value: LayoutPresetName; label: string }[] = [
  { value: 'DEFAULT', label: 'Default' },
  { value: 'DIN_5008_A', label: 'DIN 5008 Form A' },
  { value: 'DIN_5008_B', label: 'DIN 5008 Form B' },
  { value: 'MINIMAL', label: 'Minimal' },
];

/**
 * The visual layout editor: the real PDF (rendered by the server, drawn with pdf.js) with an editing layer on top,
 * the block list on the left and the properties of the selection on the right. Every change re-renders the PDF
 * (debounced); the measured blocks and the layout issues come back with it. Saving is disabled while the layout
 * checks report errors.
 */
export function LayoutEditor({
  saved,
  canUpdate,
}: {
  saved: { document: LayoutDocument; logoAssetId?: string | null };
  canUpdate: boolean;
}) {
  const queryClient = useQueryClient();
  const [history, setHistory] = useState<History>({ past: [], present: saved.document, future: [] });
  const [logoAssetId, setLogoAssetId] = useState<string | null | undefined>(saved.logoAssetId);
  const [selected, setSelected] = useState<string | undefined>();
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(0.3);
  const [page, setPage] = useState(1);
  const [options, setOptions] = useState<PreviewOptions>(DEFAULT_PREVIEW_OPTIONS);
  const [picker, setPicker] = useState<{ blockKey?: string } | undefined>();
  const [pendingPreset, setPendingPreset] = useState<LayoutPresetName | undefined>();
  const layout = history.present;

  const change = useCallback((next: LayoutDocument) => {
    setHistory((h) => (next === h.present ? h : { past: [...h.past, h.present].slice(-HISTORY), present: next, future: [] }));
  }, []);
  const undo = () =>
    setHistory((h) =>
      h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h,
    );
  const redo = () =>
    setHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h));

  const { preview, isFetching, error, noOrder } = useLayoutPreview(
    { layout: { document: layout, logoAssetId: logoAssetId ?? null } },
    options,
  );
  const pageCount = preview?.pageCount || 1;
  const issues = (preview?.layoutIssues ?? []) as LayoutIssue[];
  const errors = issues.filter((i) => i.level === 'error');
  const dirty = JSON.stringify(layout) !== JSON.stringify(saved.document) || (logoAssetId ?? null) !== (saved.logoAssetId ?? null);
  const block = layout.blocks.find((b) => b.key === selected);

  const logo = useQuery({
    queryKey: ['e-invoice-logo', logoAssetId],
    queryFn: () => api.query(assetDocument, { id: logoAssetId as string }),
    enabled: !!logoAssetId,
  });

  const save = useMutation({
    mutationFn: () => api.mutate(updateSettingsDocument, { input: { layout: { document: layout, logoAssetId: logoAssetId ?? null } } }),
    onSuccess: () => {
      toast.success('Layout saved');
      return queryClient.invalidateQueries({ queryKey: ['e-invoice-settings'] });
    },
    onError: (e) => toast.error('Could not save the layout', { description: errorMessage(e) }),
  });

  const applyPreset = useMutation({
    mutationFn: (preset: LayoutPresetName) => api.query(defaultLayoutDocument, { preset }),
    onSuccess: ({ eInvoiceDefaultLayout }) => {
      const next = eInvoiceDefaultLayout as LayoutDocument;
      // keep the theme and the texts of the current layout
      const texts = new Map(layout.blocks.filter((b) => typeof b.props?.text === 'string').map((b) => [b.type, b.props!.text]));
      change({
        ...next,
        theme: layout.theme,
        blocks: next.blocks.map((b) => (texts.has(b.type) ? { ...b, props: { ...b.props, text: texts.get(b.type) } } : b)),
      });
      setSelected(undefined);
      setPendingPreset(undefined);
    },
    onError: (e) => toast.error('Could not load the preset', { description: errorMessage(e) }),
  });

  const add = (type: 'customText' | 'image' | 'pageNumber') => {
    const key = newBlockKey(layout, type);
    const block: Block = {
      key,
      type,
      visible: true,
      pages: type === 'pageNumber' ? 'all' : 'first',
      overflow: 'fixed',
      frame:
        type === 'pageNumber'
          ? { x: 1500, y: 2500, w: 400, h: 60 }
          : { x: 198, y: 300, w: type === 'image' ? 400 : 800, h: type === 'image' ? 200 : 100 },
      ...(type === 'customText' ? { props: { text: 'Text' } } : {}),
      ...(type === 'pageNumber' ? { style: { align: 'right' as const, fontSize: 7 } } : {}),
    };
    change({ ...layout, blocks: [...layout.blocks, block] });
    setSelected(key);
    if (type === 'image') setPicker({ blockKey: key });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      return redo();
    }
    if (!block) return;
    if (e.key === 'Escape') return setSelected(undefined);
    if ((e.key === 'Delete' || e.key === 'Backspace') && ['customText', 'image', 'pageNumber'].includes(block.type)) {
      e.preventDefault();
      setSelected(undefined);
      return change(removeBlock(layout, block.key));
    }
    const step = e.shiftKey ? 50 : 5;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (d && !locked.has(block.key)) {
      e.preventDefault();
      change(
        updateBlock(layout, block.key, (b) => ({
          ...b,
          frame: { ...b.frame, x: b.frame.x + d[0], y: b.frame.y + d[1] },
          anchor: d[1] ? undefined : b.anchor,
        })),
      );
    }
  };

  const boxes = useMemo(() => preview?.blocks ?? [], [preview]);
  const logoControl = (
    <div className="grid gap-1.5">
      {logoAssetId && logo.data?.asset && (
        <img src={logo.data.asset.preview + '?preset=thumb'} alt={logo.data.asset.name} className="h-12 w-auto object-contain" />
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setPicker({})}>
          {logoAssetId ? 'Change logo' : 'Select logo'}
        </Button>
        {logoAssetId && (
          <Button size="sm" variant="ghost" onClick={() => setLogoAssetId(null)}>
            Remove
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">PNG, JPEG or SVG, at most 2 MB; scaled to fit the frame</p>
    </div>
  );

  return (
    <div className="space-y-3 outline-none" tabIndex={0} onKeyDown={onKeyDown}>
      {canUpdate && <UnsavedChangesGuard dirty={dirty && !save.isPending} />}
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button size="sm" variant="outline" disabled={!history.past.length} onClick={undo} title="Undo (Ctrl+Z)">
          Undo
        </Button>
        <Button size="sm" variant="outline" disabled={!history.future.length} onClick={redo} title="Redo (Ctrl+Shift+Z)">
          Redo
        </Button>
        <select
          aria-label="Zoom"
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        >
          {ZOOMS.map((z) => (
            <option key={z} value={z}>
              {Math.round((z / 0.3) * 100)} %
            </option>
          ))}
        </select>
        <select
          aria-label="Preset"
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value=""
          onChange={(e) => e.target.value && setPendingPreset(e.target.value as LayoutPresetName)}
        >
          <option value="">Presets / reset…</option>
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {pendingPreset && (
          <span className="flex items-center gap-2 rounded border border-amber-500 px-2 py-1">
            Replace the layout with “{PRESETS.find((p) => p.value === pendingPreset)?.label}”?
            <Button size="sm" onClick={() => applyPreset.mutate(pendingPreset)}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingPreset(undefined)}>
              Cancel
            </Button>
          </span>
        )}
        {canUpdate && errors.length > 0 && (
          <span className="ml-auto text-xs text-destructive">
            {errors.length === 1 ? '1 error' : `${errors.length} errors`} below must be fixed before saving
          </span>
        )}
        {canUpdate && (
          <Button
            size="sm"
            className={errors.length ? '' : 'ml-auto'}
            disabled={!dirty || errors.length > 0 || save.isPending || isFetching}
            title={errors.length ? 'Fix the errors first' : undefined}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[15rem_1fr_18rem]">
        <div className="order-2 xl:order-1">
          <BlockList
            layout={layout}
            selected={selected}
            locked={locked}
            issues={issues}
            onSelect={setSelected}
            onChange={change}
            onToggleLock={(key) =>
              setLocked((l) => {
                const next = new Set(l);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onAdd={add}
          />
        </div>

        <div className="order-1 min-w-0 space-y-2 xl:order-2">
          <PreviewToolbar options={options} onChange={setOptions} preview={preview} page={page} onPage={setPage} isFetching={isFetching} />
          <div className="overflow-auto rounded border bg-muted/40 p-4">
            <div className="relative mx-auto bg-white shadow" style={{ width: PAGE.w * zoom, height: PAGE.h * zoom }}>
              <PdfCanvas
                pdf={preview?.pdf}
                page={Math.min(page, pageCount)}
                scale={zoom}
                onError={(e) => toast.error('Could not display the PDF', { description: errorMessage(e) })}
              />
              <LayoutOverlay
                layout={layout}
                boxes={boxes}
                page={Math.min(page, pageCount)}
                pageCount={pageCount}
                scale={zoom}
                selected={selected}
                locked={locked}
                issues={issues}
                onSelect={setSelected}
                onChange={change}
              />
            </div>
          </div>
          {issues.length > 0 && (
            <ul className="space-y-1 text-sm" aria-label="Layout issues">
              {issues.map((issue, i) => (
                <li key={`${issue.code}-${i}`} className={issue.level === 'error' ? 'text-destructive' : 'text-amber-700'}>
                  <button
                    type="button"
                    className="text-left hover:underline"
                    disabled={!issue.blockKey}
                    onClick={() => issue.blockKey && setSelected(issue.blockKey)}
                  >
                    <span className="font-mono text-xs">{issue.code}</span> {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <PreviewIssues preview={preview} noOrder={noOrder} error={error} />
        </div>

        <div className="order-3">
          <Properties
            layout={layout}
            block={block}
            onChange={change}
            onRemove={(key) => {
              setSelected(undefined);
              change(removeBlock(layout, key));
            }}
            onPickImage={(blockKey) => setPicker({ blockKey })}
            logo={logoControl}
          />
          {block && (
            <Button size="sm" variant="ghost" className="mt-3" onClick={() => setSelected(undefined)}>
              ← Page and theme
            </Button>
          )}
        </div>
      </div>

      <AssetPickerDialog
        open={!!picker}
        onClose={() => setPicker(undefined)}
        onSelect={(assets: { id: string }[]) => {
          const asset = assets[0];
          if (asset && picker?.blockKey) {
            change(updateBlock(layout, picker.blockKey, (b) => ({ ...b, props: { ...b.props, assetId: asset.id } })));
          } else if (asset) {
            setLogoAssetId(asset.id);
          }
          setPicker(undefined);
        }}
        title={picker?.blockKey ? `Select an image for ${BLOCK_LABELS.image}` : 'Select a logo'}
      />
    </div>
  );
}
