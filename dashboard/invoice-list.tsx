import {
  ActionBarItem,
  AnyRoute,
  api,
  BulkActionComponent,
  Button,
  DataTableBulkActionItem,
  Link,
  ListPage,
  Money,
  toast,
} from '@vendure/dashboard';

import { errorMessage, formatLabel, reasonLabel, StatusBadge, typeLabel } from './common';
import { EInvoiceFormat, eInvoiceListDocument, EInvoiceStatus, EInvoiceType, zipLinkDocument } from './graphql';

type Row = { id: string; status: EInvoiceStatus } & Record<string, any>;

const DownloadZipBulkAction: BulkActionComponent<Row> = ({ selection }) => {
  const issued = selection.filter((row) => row.status === 'ISSUED');
  return (
    <DataTableBulkActionItem
      label={`Download ZIP (${issued.length})`}
      disabled={issued.length === 0}
      onClick={async () => {
        try {
          const { createEInvoiceZipLink } = await api.mutate(zipLinkDocument, { ids: issued.map((row) => row.id) });
          window.location.assign(createEInvoiceZipLink);
        } catch (e) {
          toast.error('Download failed', { description: errorMessage(e) });
        }
      }}
    />
  );
};

/** All invoices and credit notes of the channel. */
export function InvoiceListPage({ route }: { route: AnyRoute }) {
  return (
    <ListPage
      pageId="e-invoice-list"
      route={route}
      title="E-Invoices"
      listQuery={eInvoiceListDocument as any}
      defaultSort={[{ id: 'createdAt', desc: true }]}
      defaultVisibility={
        {
          number: true,
          type: true,
          status: true,
          issueDate: true,
          orderCode: true,
          totalWithTax: true,
          files: true,
          reason: false,
          totalNet: false,
          totalTax: false,
          currencyCode: false,
          createdAt: false,
          updatedAt: false,
          order: false,
        } as any
      }
      defaultColumnOrder={['number', 'type', 'status', 'issueDate', 'orderCode', 'totalWithTax', 'files'] as any}
      searchPlaceholder="Search by number or order code…"
      onSearchTermChange={(term: string) =>
        (term ? { _or: [{ number: { contains: term } }, { orderCode: { contains: term } }] } : {}) as any
      }
      facetedFilters={
        {
          type: {
            title: 'Type',
            options: [
              { label: 'Invoice', value: 'INVOICE' },
              { label: 'Credit note', value: 'CREDIT_NOTE' },
            ],
          },
          status: {
            title: 'Status',
            options: ['ISSUED', 'PENDING', 'BLOCKED', 'FAILED', 'VOID'].map((s) => ({ label: s, value: s })),
          },
        } as any
      }
      customizeColumns={
        {
          number: { cell: ({ row }: any) => row.original.number ?? '—' },
          type: { cell: ({ row }: any) => typeLabel(row.original.type as EInvoiceType) },
          status: { cell: ({ row }: any) => <StatusBadge status={row.original.status} /> },
          reason: { cell: ({ row }: any) => reasonLabel[row.original.reason] ?? row.original.reason },
          orderCode: {
            header: 'Order',
            // The list query only selects visible columns; these cells need more fields
            meta: { dependencies: ['order'] },
            cell: ({ row }: any) =>
              row.original.order?.id ? (
                <Link to={`/orders/${row.original.order.id}`} className="text-primary underline-offset-4 hover:underline">
                  {row.original.orderCode}
                </Link>
              ) : (
                row.original.orderCode
              ),
          },
          totalWithTax: {
            meta: { dependencies: ['type', 'currencyCode'] },
            cell: ({ row }: any) => (
              <Money
                value={row.original.type === 'CREDIT_NOTE' ? -row.original.totalWithTax : row.original.totalWithTax}
                currency={row.original.currencyCode}
              />
            ),
          },
          files: {
            meta: { dependencies: ['status'] },
            cell: ({ row }: any) => (
              <div className="flex gap-2">
                {row.original.files.map((f: { format: EInvoiceFormat; downloadUrl: string }) => (
                  <a key={f.format} href={f.downloadUrl} className="text-primary underline-offset-4 hover:underline">
                    {formatLabel[f.format]}
                  </a>
                ))}
              </div>
            ),
          },
        } as any
      }
      bulkActions={[{ component: DownloadZipBulkAction }] as any}
    >
      <ActionBarItem itemId="e-invoice-settings-button" requiresPermission={['ReadEInvoice']}>
        <Button variant="outline" render={<Link to="/e-invoices/settings" />}>
          Settings
        </Button>
      </ActionBarItem>
    </ListPage>
  );
}
