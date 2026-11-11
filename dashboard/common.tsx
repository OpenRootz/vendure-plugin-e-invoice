import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Link,
  useBlocker,
} from '@vendure/dashboard';

import type { EInvoiceFormat, EInvoiceIssue, EInvoiceStatus, EInvoiceType } from './graphql';

export const CREATE = 'CreateEInvoice';
export const READ = 'ReadEInvoice';
export const UPDATE = 'UpdateEInvoice';

const STATUS: Record<EInvoiceStatus, { label: string; variant: 'success' | 'warning' | 'destructive' | 'default' | 'outline' }> = {
  ISSUED: { label: 'Issued', variant: 'success' },
  PENDING: { label: 'Rendering', variant: 'default' },
  BLOCKED: { label: 'Blocked', variant: 'warning' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  VOID: { label: 'Void', variant: 'outline' },
};

export function StatusBadge({ status }: { status: EInvoiceStatus }) {
  const s = STATUS[status] ?? { label: status, variant: 'outline' as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export const typeLabel = (type: EInvoiceType) => (type === 'CREDIT_NOTE' ? 'Credit note' : 'Invoice');

export const formatLabel: Record<EInvoiceFormat, string> = {
  ZUGFERD: 'PDF (ZUGFeRD)',
  XRECHNUNG_CII: 'XRechnung (CII)',
  XRECHNUNG_UBL: 'XRechnung (UBL)',
};

export const reasonLabel: Record<string, string> = {
  auto: 'Automatic',
  manual: 'Manual',
  refund: 'Refund',
  cancellation: 'Cancellation',
  modification: 'Order modification',
};

/** Where an issue can be fixed in the dashboard. */
function issueTarget(path?: string | null): string | undefined {
  if (!path) return undefined;
  const taxRate = /^taxRate:(.+)$/.exec(path);
  if (taxRate) return `/tax-rates/${taxRate[1]}`;
  if (path.startsWith('layout')) return '/e-invoices/layout';
  if (path === 'enabled' || path.startsWith('seller') || path.startsWith('payment')) return '/e-invoices/settings';
  return undefined;
}

export function IssueList({ issues }: { issues: EInvoiceIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {issues.map((issue, i) => {
        const target = issueTarget(issue.path);
        return (
          <li key={`${issue.code}-${i}`}>
            <span className="font-mono text-xs text-muted-foreground">{issue.code}</span> {issue.message}
            {target && (
              <>
                {' '}
                <Link to={target} className="text-primary underline-offset-4 hover:underline">
                  Fix
                </Link>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Opens a PDF data URL (as returned by the preview) in a new tab. */
export function openPdf(dataUrl: string) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Asks before leaving the page (or closing the tab) while there are unsaved changes. */
export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  const { proceed, reset, status } = useBlocker({ shouldBlockFn: () => dirty, withResolver: true, enableBeforeUnload: () => dirty });
  return (
    <Dialog open={status === 'blocked'} onOpenChange={(open) => !open && reset?.()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>The changes on this page have not been saved and will be lost.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => reset?.()}>
            Stay on this page
          </Button>
          <Button onClick={() => proceed?.()}>Discard changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
