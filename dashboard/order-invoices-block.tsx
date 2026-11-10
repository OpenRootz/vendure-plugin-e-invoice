import {
  api,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Money,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
  useMutation,
  usePermissions,
  useQuery,
  useQueryClient,
} from '@vendure/dashboard';
import { Fragment, useState } from 'react';

import { CREATE, errorMessage, formatLabel, IssueList, openPdf, reasonLabel, StatusBadge, typeLabel, UPDATE } from './common';
import { CreditNoteDialog } from './credit-note-dialog';
import {
  cancelAndReissueDocument,
  createInvoiceDocument,
  EInvoiceRow,
  guestLinkDocument,
  orderEInvoicesDocument,
  previewDocument,
  retryDocument,
  voidDocument,
} from './graphql';

/** Invoices and credit notes of an order, with downloads and actions. Shown on the order detail page. */
export function OrderInvoicesBlock({ orderId }: { orderId: string }) {
  const queryClient = useQueryClient();
  const { hasPermissions } = usePermissions();
  const canCreate = hasPermissions([CREATE]);
  const canUpdate = hasPermissions([UPDATE]);
  const queryKey = ['e-invoices-of-order', orderId];
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => api.query(orderEInvoicesDocument, { id: orderId }),
    // Rendering runs in the background: poll while a document is pending
    refetchInterval: (query) => (query.state.data?.order?.eInvoices.some((i) => i.status === 'PENDING') ? 2000 : false),
  });
  const [creditFor, setCreditFor] = useState<string | undefined>();
  const [voiding, setVoiding] = useState<EInvoiceRow | undefined>();
  const [confirmReissue, setConfirmReissue] = useState<EInvoiceRow | undefined>();

  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const run = (success: string, fn: () => Promise<unknown>) =>
    fn()
      .then(() => {
        toast.success(success);
        return refresh();
      })
      .catch((e) => toast.error('Action failed', { description: errorMessage(e) }));

  const preview = useMutation({
    mutationFn: () => api.query(previewDocument, { orderId }),
    onSuccess: ({ eInvoicePreview }) => {
      if (eInvoicePreview.issues.length) {
        toast.warning('The invoice would be blocked', { description: eInvoicePreview.issues.map((i) => i.message).join('\n') });
      }
      if (eInvoicePreview.pdf) openPdf(eInvoicePreview.pdf);
    },
    onError: (e) => toast.error('Preview failed', { description: errorMessage(e) }),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (error) return <div className="text-sm text-destructive">{errorMessage(error)}</div>;
  const invoices = data?.order?.eInvoices ?? [];
  const hasOpenInvoice = invoices.some(
    (i) => i.type === 'INVOICE' && ['PENDING', 'ISSUED', 'FAILED'].includes(i.status) && i.remainingAmount > 0,
  );
  const hasBlocked = invoices.some((i) => i.type === 'INVOICE' && i.status === 'BLOCKED');

  return (
    <div className="space-y-3">
      {invoices.length === 0 ? (
        <div className="text-sm text-muted-foreground">No invoice yet.</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Files</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((inv) => (
              <Fragment key={inv.id}>
                <TableRow>
                  <TableCell>
                    <div className="font-medium">{inv.number ?? '—'}</div>
                    <div className="text-xs text-muted-foreground">
                      {typeLabel(inv.type)} · {reasonLabel[inv.reason] ?? inv.reason}
                      {inv.correctedInvoice?.number && <> · corrects {inv.correctedInvoice.number}</>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={inv.status} />
                    {inv.validation && !inv.validation.valid && (
                      <div className="mt-1 text-xs text-warning">Validation: {inv.validation.error ?? 'rejected'}</div>
                    )}
                  </TableCell>
                  <TableCell>{inv.issueDate ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    <Money value={inv.type === 'CREDIT_NOTE' ? -inv.totalWithTax : inv.totalWithTax} currency={inv.currencyCode} />
                    {inv.type === 'INVOICE' && inv.number && inv.remainingAmount !== inv.totalWithTax && (
                      <div className="text-xs text-muted-foreground">
                        open: <Money value={inv.remainingAmount} currency={inv.currencyCode} />
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      {inv.files.map((f) => (
                        <a key={f.format} href={f.downloadUrl} className="text-sm text-primary underline-offset-4 hover:underline">
                          {formatLabel[f.format]}
                        </a>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1">
                      {inv.status === 'ISSUED' && (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            run('Guest link copied', async () => {
                              const { createEInvoiceGuestLink } = await api.mutate(guestLinkDocument, { invoiceId: inv.id });
                              await navigator.clipboard.writeText(createEInvoiceGuestLink);
                            })
                          }
                        >
                          Copy guest link
                        </Button>
                      )}
                      {canCreate && inv.type === 'INVOICE' && inv.number && inv.status !== 'VOID' && inv.remainingAmount > 0 && (
                        <>
                          <Button size="xs" variant="outline" onClick={() => setCreditFor(inv.id)}>
                            Credit note…
                          </Button>
                          <Button size="xs" variant="outline" onClick={() => setConfirmReissue(inv)}>
                            Cancel & reissue
                          </Button>
                        </>
                      )}
                      {canUpdate && (inv.status === 'BLOCKED' || inv.status === 'FAILED') && (
                        <Button size="xs" variant="outline" onClick={() => run('Retry started', () => api.mutate(retryDocument, { id: inv.id }))}>
                          Retry
                        </Button>
                      )}
                      {canUpdate && inv.status === 'FAILED' && (
                        <Button size="xs" variant="destructive" onClick={() => setVoiding(inv)}>
                          Void…
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                {(inv.issues.length > 0 || inv.errorMessage || inv.voidReason) && (
                  <TableRow>
                    <TableCell colSpan={6} className="bg-muted/40">
                      {inv.status === 'BLOCKED' && <div className="mb-1 text-sm font-medium">Fix these problems, then retry:</div>}
                      <IssueList issues={inv.issues} />
                      {inv.errorMessage && <div className="text-sm text-destructive">{inv.errorMessage}</div>}
                      {inv.voidReason && <div className="text-sm text-muted-foreground">Voided: {inv.voidReason}</div>}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="flex gap-2">
        {canCreate && !hasOpenInvoice && !hasBlocked && (
          <Button size="sm" onClick={() => run('Invoice created', () => api.mutate(createInvoiceDocument, { orderId }))}>
            Create invoice
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={preview.isPending} onClick={() => preview.mutate()}>
          Preview PDF
        </Button>
      </div>

      {creditFor && (
        <CreditNoteDialog
          invoiceId={creditFor}
          open
          onClose={(created) => {
            setCreditFor(undefined);
            if (created) void refresh();
          }}
        />
      )}
      {confirmReissue && (
        <Dialog open onOpenChange={(o) => !o && setConfirmReissue(undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cancel and reissue {confirmReissue.number}?</DialogTitle>
            </DialogHeader>
            <p className="text-sm">
              The invoice is credited in full and a new invoice is issued for the current order, e.g. after correcting
              the buyer data. Both documents get new numbers.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmReissue(undefined)}>
                Keep
              </Button>
              <Button
                onClick={() => {
                  const id = confirmReissue.id;
                  setConfirmReissue(undefined);
                  void run('Invoice reissued', () => api.mutate(cancelAndReissueDocument, { invoiceId: id }));
                }}
              >
                Cancel & reissue
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {voiding && <VoidDialog invoice={voiding} onClose={() => setVoiding(undefined)} onDone={refresh} />}
    </div>
  );
}

function VoidDialog({ invoice, onClose, onDone }: { invoice: EInvoiceRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.mutate(voidDocument, { id: invoice.id, reason }),
    onSuccess: () => {
      toast.success(`${invoice.number} voided`);
      onClose();
      onDone();
    },
    onError: (e) => toast.error('Could not void', { description: errorMessage(e) }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void {invoice.number}?</DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          Only for documents that can never be rendered. The number stays used; the reason documents the gap in the
          number sequence. This cannot be undone.
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor="void-reason">Reason</Label>
          <Textarea id="void-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!reason.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            Void
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
