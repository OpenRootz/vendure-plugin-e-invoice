import { api, Button, Spinner, useQuery } from '@vendure/dashboard';
import { useEffect, useState } from 'react';

import { IssueList, openPdf } from './common';
import { EInvoiceSample, LayoutPreview, LayoutPreviewInput, latestOrderDocument, layoutPreviewDocument } from './graphql';

/** `value`, updated only after it has not changed for `delay` ms. */
export function useDebounced<T>(value: T, delay = 500): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export const SAMPLES: { value: EInvoiceSample; label: string }[] = [
  { value: 'B2B_NET', label: 'Business, net prices' },
  { value: 'B2C_GROSS', label: 'Consumer, gross prices' },
  { value: 'CREDIT_NOTE', label: 'Credit note' },
  { value: 'MANY_LINES', label: 'Many lines (page breaks)' },
  { value: 'WORST_CASE', label: 'Worst case (longest content)' },
];

export interface PreviewOptions {
  sample: EInvoiceSample;
  /** Empty: the channel language, like the invoices */
  language: string;
  /** Render the latest order instead of sample data */
  useLatestOrder: boolean;
}

export const DEFAULT_PREVIEW_OPTIONS: PreviewOptions = { sample: 'B2B_NET', language: '', useLatestOrder: false };

/**
 * The live preview: re-rendered on the server 500 ms after the last change of the draft. While a new PDF is
 * rendered, the previous one stays visible; responses for outdated drafts are discarded.
 */
export function useLayoutPreview(draft: Omit<LayoutPreviewInput, 'sample' | 'language' | 'orderId'>, options: PreviewOptions) {
  const latestOrder = useQuery({
    queryKey: ['e-invoice-latest-order'],
    queryFn: () => api.query(latestOrderDocument),
    enabled: options.useLatestOrder,
  });
  const orderId = options.useLatestOrder ? latestOrder.data?.orders.items[0]?.id : undefined;
  const input: LayoutPreviewInput = {
    ...draft,
    sample: options.sample,
    ...(options.language ? { language: options.language } : {}),
    ...(orderId ? { orderId } : {}),
  };
  const debounced = useDebounced(input);
  const query = useQuery({
    queryKey: ['e-invoice-layout-preview', debounced],
    queryFn: () => api.query(layoutPreviewDocument, { input: debounced }),
    placeholderData: (previous) => previous,
    enabled: !options.useLatestOrder || latestOrder.isFetched,
    staleTime: Infinity,
  });
  const noOrder = options.useLatestOrder && latestOrder.isFetched && !orderId;
  return {
    preview: query.data?.eInvoiceLayoutPreview,
    isFetching: query.isFetching || JSON.stringify(input) !== JSON.stringify(debounced),
    error: query.error,
    noOrder,
  };
}

const selectClass = 'h-8 rounded-md border bg-background px-2 text-sm';

/** Sample, language and order selection plus page navigation above the preview. */
export function PreviewToolbar({
  options,
  onChange,
  preview,
  page,
  onPage,
  isFetching,
}: {
  options: PreviewOptions;
  onChange: (o: PreviewOptions) => void;
  preview?: LayoutPreview;
  page: number;
  onPage: (page: number) => void;
  isFetching: boolean;
}) {
  const pageCount = preview?.pageCount ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <select
        aria-label="Sample data"
        className={selectClass}
        value={options.sample}
        disabled={options.useLatestOrder}
        onChange={(e) => onChange({ ...options, sample: e.target.value as EInvoiceSample })}
      >
        {SAMPLES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Language"
        className={selectClass}
        value={options.language}
        onChange={(e) => onChange({ ...options, language: e.target.value })}
      >
        <option value="">Channel language</option>
        <option value="de">Deutsch</option>
        <option value="en">English</option>
      </select>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={options.useLatestOrder}
          onChange={(e) => onChange({ ...options, useLatestOrder: e.target.checked })}
        />
        Latest order
      </label>
      {pageCount > 1 && (
        <select aria-label="Page" className={selectClass} value={page} onChange={(e) => onPage(Number(e.target.value))}>
          {Array.from({ length: pageCount }, (_, i) => (
            <option key={i} value={i + 1}>
              Page {i + 1} of {pageCount}
            </option>
          ))}
        </select>
      )}
      {isFetching && <Spinner className="h-4 w-4" />}
      <Button size="sm" variant="outline" className="ml-auto" disabled={!preview?.pdf} onClick={() => preview?.pdf && openPdf(preview.pdf)}>
        Open in new tab
      </Button>
    </div>
  );
}

/** Issues of the preview (seller data, logo, layout) below the PDF. */
export function PreviewIssues({ preview, noOrder, error }: { preview?: LayoutPreview; noOrder?: boolean; error?: unknown }) {
  return (
    <div className="space-y-2">
      {noOrder && <p className="text-sm text-muted-foreground">There is no placed order yet; showing nothing.</p>}
      {error ? <p className="text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</p> : null}
      {preview && preview.issues.length > 0 && <IssueList issues={preview.issues} />}
    </div>
  );
}
