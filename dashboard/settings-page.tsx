import {
  api,
  Button,
  Input,
  Label,
  Link,
  Page,
  PageActionBar,
  PageActionBarRight,
  PageBlock,
  PageLayout,
  PageTitle,
  Switch,
  Textarea,
  toast,
  useMutation,
  usePermissions,
  useQuery,
  useQueryClient,
} from '@vendure/dashboard';
import { useEffect, useState } from 'react';

import { errorMessage, IssueList, openPdf, UnsavedChangesGuard, UPDATE } from './common';
import { ChannelSettings, layoutPreviewDocument, settingsDocument, updateSettingsDocument } from './graphql';

const EMPTY: ChannelSettings = { enabled: false, autoIssue: true, seller: {}, payment: {}, layout: {} };

/** Sets `value` at a dotted path of a copy of `obj`. */
function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const copy: any = structuredClone(obj);
  const keys = path.split('.');
  let target = copy;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys[keys.length - 1]] = value;
  return copy;
}

const getPath = (obj: unknown, path: string): any => path.split('.').reduce((o: any, k) => o?.[k], obj);

/**
 * Builds the update input: empty strings are sent as null (cleared), so nested objects without content drop out.
 * The layout is edited on its own page and not sent from here.
 */
function toInput(s: ChannelSettings) {
  const blank = (v: unknown) => v === undefined || v === null || v === '';
  const clean = (o: Record<string, any> | null | undefined, required: string[] = []) => {
    if (!o) return null;
    const out = Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== '__typename' && !blank(v)));
    return Object.keys(out).length && required.every((k) => !blank(out[k])) ? out : null;
  };
  const { seller, payment } = s;
  return {
    enabled: s.enabled,
    autoIssue: s.autoIssue,
    seller: {
      ...clean({
        name: seller.name,
        tradingName: seller.tradingName,
        vatId: seller.vatId,
        taxNumber: seller.taxNumber,
        legalInfo: seller.legalInfo,
      }),
      address: clean(seller.address),
      contact: clean(seller.contact),
      electronicAddress: clean(seller.electronicAddress, ['scheme', 'value']),
      legalRegistration: clean(seller.legalRegistration, ['id']),
      bank: clean(seller.bank, ['iban']),
    },
    payment: { termsText: payment.termsText || null, termDays: payment.termDays ? Number(payment.termDays) : null },
  };
}

function Field({
  label,
  path,
  value,
  onChange,
  hint,
  multiline,
  type,
}: {
  label: string;
  path: string;
  value: ChannelSettings;
  onChange: (path: string, v: unknown) => void;
  hint?: string;
  multiline?: boolean;
  type?: string;
}) {
  const id = `e-invoice-${path}`;
  const current = getPath(value, path) ?? '';
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <Textarea id={id} value={current} onChange={(e) => onChange(path, e.target.value)} />
      ) : (
        <Input
          id={id}
          type={type}
          value={current}
          onChange={(e) => onChange(path, type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
        />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const grid = 'grid gap-4 md:grid-cols-2';

/** E-invoicing settings of the active channel: seller data and payment terms. The PDF layout has its own page. */
export function SettingsPage() {
  const queryClient = useQueryClient();
  const { hasPermissions } = usePermissions();
  const canUpdate = hasPermissions([UPDATE]);
  const { data, isLoading } = useQuery({ queryKey: ['e-invoice-settings'], queryFn: () => api.query(settingsDocument) });
  const [settings, setSettings] = useState<ChannelSettings>(EMPTY);

  useEffect(() => {
    if (data) setSettings(data.eInvoiceChannelSettings);
  }, [data]);

  const change = (path: string, value: unknown) => setSettings((s) => setPath(s, path, value));
  const fieldProps = { value: settings, onChange: change };

  const save = useMutation({
    mutationFn: () => api.mutate(updateSettingsDocument, { input: toInput(settings) }),
    onSuccess: () => {
      toast.success('Settings saved');
      return queryClient.invalidateQueries({ queryKey: ['e-invoice-settings'] });
    },
    onError: (e) => toast.error('Could not save the settings', { description: errorMessage(e) }),
  });

  // Sample invoice with the unsaved seller and payment data, so it also works before the first order
  const preview = useMutation({
    mutationFn: () => {
      const { seller, payment } = toInput(settings);
      return api.query(layoutPreviewDocument, { input: { seller, payment, sample: 'B2B_NET' } });
    },
    onSuccess: ({ eInvoiceLayoutPreview }) => {
      if (eInvoiceLayoutPreview.issues.length) {
        toast.warning('Invoices would be blocked', { description: eInvoiceLayoutPreview.issues.map((i) => i.message).join('\n') });
      }
      if (eInvoiceLayoutPreview.pdf) openPdf(eInvoiceLayoutPreview.pdf);
    },
    onError: (e) => toast.error('Preview failed', { description: errorMessage(e) }),
  });

  if (isLoading) return null;
  const setupIssues = data?.eInvoiceSetupStatus ?? [];
  const dirty = !!data && JSON.stringify(toInput(settings)) !== JSON.stringify(toInput(data.eInvoiceChannelSettings));

  return (
    <Page pageId="e-invoice-settings">
      {canUpdate && <UnsavedChangesGuard dirty={dirty && !save.isPending} />}
      <PageTitle>E-Invoice settings</PageTitle>
      <PageActionBar>
        <PageActionBarRight>
          <Button variant="outline" disabled={preview.isPending} onClick={() => preview.mutate()}>
            Preview PDF (sample)
          </Button>
          {canUpdate && (
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          )}
        </PageActionBarRight>
      </PageActionBar>
      <PageLayout>
        {setupIssues.length > 0 && (
          <PageBlock column="main" blockId="e-invoice-setup-status" title="Before invoices can be issued">
            <IssueList issues={setupIssues} />
          </PageBlock>
        )}
        <PageBlock column="side" blockId="e-invoice-general" title="General">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Switch id="e-invoice-enabled" checked={settings.enabled} onCheckedChange={(v: boolean) => change('enabled', v)} />
              <Label htmlFor="e-invoice-enabled">E-invoicing enabled for this channel</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="e-invoice-auto" checked={settings.autoIssue} onCheckedChange={(v: boolean) => change('autoIssue', v)} />
              <Label htmlFor="e-invoice-auto">Issue invoices automatically (e.g. when the payment is settled)</Label>
            </div>
          </div>
        </PageBlock>
        <PageBlock column="main" blockId="e-invoice-seller" title="Seller">
          <div className={grid}>
            <Field label="Legal name" path="seller.name" {...fieldProps} />
            <Field label="Trading name" path="seller.tradingName" {...fieldProps} />
            <Field label="Street" path="seller.address.line1" {...fieldProps} />
            <Field label="Address line 2" path="seller.address.line2" {...fieldProps} />
            <Field label="Postal code" path="seller.address.postalCode" {...fieldProps} />
            <Field label="City" path="seller.address.city" {...fieldProps} />
            <Field label="Country code" path="seller.address.countryCode" hint="ISO 3166-1, e.g. DE" {...fieldProps} />
            <Field label="VAT ID" path="seller.vatId" hint="e.g. DE123456789" {...fieldProps} />
            <Field label="Tax number" path="seller.taxNumber" hint="Steuernummer, if there is no VAT ID" {...fieldProps} />
            <Field
              label="Commercial register"
              path="seller.legalRegistration.id"
              hint="e.g. HRB 12345, Amtsgericht Berlin"
              {...fieldProps}
            />
            <Field label="Legal information" path="seller.legalInfo" hint="e.g. managing directors" {...fieldProps} />
          </div>
        </PageBlock>
        <PageBlock column="main" blockId="e-invoice-contact" title="Contact and electronic address">
          <div className={grid}>
            <Field label="Contact name" path="seller.contact.name" {...fieldProps} />
            <Field label="Phone" path="seller.contact.phone" {...fieldProps} />
            <Field label="Email" path="seller.contact.email" {...fieldProps} />
            <div />
            <Field label="Electronic address scheme" path="seller.electronicAddress.scheme" hint="EM = email" {...fieldProps} />
            <Field
              label="Electronic address"
              path="seller.electronicAddress.value"
              hint="Where buyers send e-invoices, e.g. rechnung@example.com"
              {...fieldProps}
            />
          </div>
        </PageBlock>
        <PageBlock column="main" blockId="e-invoice-payment" title="Bank account and payment terms">
          <div className={grid}>
            <Field label="IBAN" path="seller.bank.iban" {...fieldProps} />
            <Field label="BIC" path="seller.bank.bic" {...fieldProps} />
            <Field label="Account holder" path="seller.bank.accountName" {...fieldProps} />
            <Field label="Payment term (days)" path="payment.termDays" type="number" {...fieldProps} />
            <Field label="Payment terms text" path="payment.termsText" hint="Used when an amount is due" multiline {...fieldProps} />
          </div>
        </PageBlock>
        <PageBlock column="side" blockId="e-invoice-layout" title="PDF layout">
          <p className="text-sm">
            Logo, colors, texts and the position of every block are set in the{' '}
            <Link to="/e-invoices/layout" className="text-primary underline-offset-4 hover:underline">
              invoice layout editor
            </Link>
            .
          </p>
        </PageBlock>
      </PageLayout>
    </Page>
  );
}
