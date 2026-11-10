import {
  api,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Money,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
  useMutation,
  useQuery,
} from '@vendure/dashboard';
import { useMemo, useState } from 'react';

import { errorMessage } from './common';
import { createCreditNoteDocument, creditableDocument } from './graphql';

interface Props {
  invoiceId: string;
  open: boolean;
  onClose: (created: boolean) => void;
}

/**
 * Credit note for an invoice: returned quantities per line, shipping, a free amount (split across the VAT
 * rates of the invoice by the server), or a full reversal. The server never credits more than was invoiced.
 */
export function CreditNoteDialog({ invoiceId, open, onClose }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['e-invoice-creditable', invoiceId],
    queryFn: () => api.query(creditableDocument, { id: invoiceId }),
    enabled: open,
  });
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [shipping, setShipping] = useState(false);
  const [amount, setAmount] = useState(0);
  const [fullReversal, setFullReversal] = useState(false);
  const [note, setNote] = useState('');

  const invoice = data?.eInvoice;
  const creditable = invoice?.creditable;
  const currency = invoice?.currencyCode ?? 'EUR';

  // Estimate only: the server computes the exact amounts per VAT rate
  const estimate = useMemo(() => {
    if (!creditable) return 0;
    if (fullReversal) return creditable.remainingTotal;
    const lines = creditable.lines.reduce((total, line) => {
      const qty = line.orderLineId ? quantities[line.orderLineId] ?? 0 : 0;
      return line.remainingQuantity ? total + Math.round((line.remainingGross * qty) / line.remainingQuantity) : total;
    }, 0);
    return lines + (shipping ? creditable.chargesGross : 0) + amount;
  }, [creditable, quantities, shipping, amount, fullReversal]);

  const mutation = useMutation({
    mutationFn: () =>
      api.mutate(createCreditNoteDocument, {
        input: {
          invoiceId,
          fullReversal: fullReversal || undefined,
          lines: fullReversal
            ? undefined
            : Object.entries(quantities)
                .filter(([, q]) => q > 0)
                .map(([orderLineId, quantity]) => ({ orderLineId, quantity })),
          shipping: !fullReversal && shipping ? true : undefined,
          amount: !fullReversal && amount ? amount : undefined,
          note: note.trim() || undefined,
        },
      }),
    onSuccess: (result) => {
      toast.success(`Credit note ${result.createEInvoiceCreditNote.number ?? ''} created`);
      reset();
      onClose(true);
    },
    onError: (e) => toast.error('Could not create the credit note', { description: errorMessage(e) }),
  });

  function reset() {
    setQuantities({});
    setShipping(false);
    setAmount(0);
    setFullReversal(false);
    setNote('');
  }

  const nothingSelected = !fullReversal && estimate === 0 && !Object.values(quantities).some((q) => q > 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(false)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Credit note for {invoice?.number ?? '…'}</DialogTitle>
          <DialogDescription>
            Items are credited at the invoiced prices. Left to credit:{' '}
            {creditable ? <Money value={creditable.remainingTotal} currency={currency} /> : '…'}
          </DialogDescription>
        </DialogHeader>
        {isLoading || !creditable ? (
          <div className="py-6 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Switch id="full-reversal" checked={fullReversal} onCheckedChange={setFullReversal} />
              <Label htmlFor="full-reversal">Credit everything that has not been credited yet</Label>
            </div>
            {!fullReversal && (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Invoiced</TableHead>
                      <TableHead className="text-right">Left</TableHead>
                      <TableHead className="w-28 text-right">Credit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {creditable.lines
                      .filter((line) => line.orderLineId)
                      .map((line) => {
                        const id = line.orderLineId as string;
                        return (
                          <TableRow key={id}>
                            <TableCell>
                              {line.name}
                              {line.sku && <div className="text-xs text-muted-foreground">{line.sku}</div>}
                            </TableCell>
                            <TableCell className="text-right">{line.invoicedQuantity}</TableCell>
                            <TableCell className="text-right">{line.remainingQuantity}</TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min={0}
                                max={line.remainingQuantity}
                                disabled={line.remainingQuantity === 0}
                                value={quantities[id] ?? 0}
                                onChange={(e) => {
                                  const q = Math.max(0, Math.min(line.remainingQuantity, Math.floor(Number(e.target.value) || 0)));
                                  setQuantities((prev) => ({ ...prev, [id]: q }));
                                }}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
                <div className="flex items-center gap-2">
                  <Switch
                    id="credit-shipping"
                    checked={shipping}
                    disabled={creditable.chargesGross === 0}
                    onCheckedChange={setShipping}
                  />
                  <Label htmlFor="credit-shipping">
                    Credit shipping and surcharges (<Money value={creditable.chargesGross} currency={currency} />)
                  </Label>
                </div>
                <div className="grid gap-1.5">
                  <Label>Additional amount in {currency} (gross, split across the VAT rates; negative = deduction)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={amount ? amount / 100 : ''}
                    placeholder="0.00"
                    onChange={(e) => setAmount(Math.round((Number(e.target.value) || 0) * 100))}
                  />
                </div>
              </>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="credit-note-text">Note on the credit note</Label>
              <Textarea id="credit-note-text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Return of 1 item" />
            </div>
            <div className="text-right text-sm">
              Estimated credit: <span className="font-semibold"><Money value={estimate} currency={currency} /></span>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button disabled={nothingSelected || mutation.isPending || !creditable} onClick={() => mutation.mutate()}>
            Create credit note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
