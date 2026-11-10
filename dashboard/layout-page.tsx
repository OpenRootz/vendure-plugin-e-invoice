import {
  api,
  AssetPickerDialog,
  Button,
  FullWidthPageBlock,
  Input,
  Label,
  Page,
  PageActionBar,
  PageActionBarRight,
  PageLayout,
  PageTitle,
  Textarea,
  toast,
  useMutation,
  usePermissions,
  useQuery,
  useQueryClient,
} from '@vendure/dashboard';
import { useEffect, useState } from 'react';

import { errorMessage, UPDATE } from './common';
import { assetDocument, ChannelSettings, settingsDocument, updateSettingsDocument } from './graphql';
import { DEFAULT_PREVIEW_OPTIONS, PdfFrame, PreviewIssues, PreviewOptions, PreviewToolbar, useLayoutPreview } from './layout-preview';

type Layout = ChannelSettings['layout'];

/** Layout input without empty values (cleared fields are dropped by the server). */
export function layoutInput(layout: Layout) {
  return Object.fromEntries(Object.entries(layout).filter(([k, v]) => k !== '__typename' && v !== '' && v !== null && v !== undefined));
}

/** Logo, accent color and texts of the PDF, with a live preview of the real PDF. */
export function LayoutPage() {
  const queryClient = useQueryClient();
  const { hasPermissions } = usePermissions();
  const canUpdate = hasPermissions([UPDATE]);
  const { data, isLoading } = useQuery({ queryKey: ['e-invoice-settings'], queryFn: () => api.query(settingsDocument) });
  const [layout, setLayout] = useState<Layout>({});
  const [assetPicker, setAssetPicker] = useState(false);
  const [options, setOptions] = useState<PreviewOptions>(DEFAULT_PREVIEW_OPTIONS);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (data) setLayout(data.eInvoiceChannelSettings.layout);
  }, [data]);

  const { preview, isFetching, error, noOrder } = useLayoutPreview({ layout: layoutInput(layout) }, options);
  useEffect(() => {
    if (preview && page > preview.pageCount) setPage(1);
  }, [preview, page]);

  const logoId = layout.logoAssetId;
  const logo = useQuery({
    queryKey: ['e-invoice-logo', logoId],
    queryFn: () => api.query(assetDocument, { id: logoId as string }),
    enabled: !!logoId,
  });

  const save = useMutation({
    mutationFn: () => api.mutate(updateSettingsDocument, { input: { layout: layoutInput(layout) } }),
    onSuccess: () => {
      toast.success('Layout saved');
      return queryClient.invalidateQueries({ queryKey: ['e-invoice-settings'] });
    },
    onError: (e) => toast.error('Could not save the layout', { description: errorMessage(e) }),
  });

  if (isLoading) return null;
  const field = (key: 'accentColor' | 'introText' | 'closingText' | 'footerText', label: string, hint?: string, multiline = true) => {
    const id = `e-invoice-layout-${key}`;
    const value = layout[key] ?? '';
    const onChange = (v: string) => setLayout((l) => ({ ...l, [key]: v }));
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {multiline ? (
          <Textarea id={id} value={value} maxLength={2000} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
        )}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    );
  };

  return (
    <Page pageId="e-invoice-layout">
      <PageTitle>Invoice layout</PageTitle>
      <PageActionBar>
        <PageActionBarRight>
          {canUpdate && (
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          )}
        </PageActionBarRight>
      </PageActionBar>
      <PageLayout>
        <FullWidthPageBlock blockId="e-invoice-layout-editor">
          <div className="grid gap-6 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
            <div className="space-y-4">
              <div className="grid gap-1.5">
                <Label>Logo</Label>
                {logoId && logo.data?.asset && (
                  <img src={logo.data.asset.preview + '?preset=thumb'} alt={logo.data.asset.name} className="h-16 w-auto object-contain" />
                )}
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setAssetPicker(true)}>
                    {logoId ? 'Change' : 'Select'}
                  </Button>
                  {logoId && (
                    <Button size="sm" variant="ghost" onClick={() => setLayout((l) => ({ ...l, logoAssetId: null }))}>
                      Remove
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">PNG, JPEG or SVG, at most 2 MB</p>
              </div>
              {field('accentColor', 'Accent color', 'Hex, e.g. #1a5fb4', false)}
              {field('introText', 'Intro text')}
              {field('closingText', 'Closing text')}
              {field('footerText', 'Footer text')}
            </div>
            <div className="flex min-h-[70vh] flex-col gap-2">
              <PreviewToolbar options={options} onChange={setOptions} preview={preview} page={page} onPage={setPage} isFetching={isFetching} />
              <div className="flex-1">
                <PdfFrame pdf={preview?.pdf} page={page} />
              </div>
              <PreviewIssues preview={preview} noOrder={noOrder} error={error} />
            </div>
          </div>
        </FullWidthPageBlock>
      </PageLayout>
      <AssetPickerDialog
        open={assetPicker}
        onClose={() => setAssetPicker(false)}
        onSelect={(assets: { id: string }[]) => {
          if (assets[0]) setLayout((l) => ({ ...l, logoAssetId: assets[0].id }));
          setAssetPicker(false);
        }}
        title="Select a logo"
      />
    </Page>
  );
}
