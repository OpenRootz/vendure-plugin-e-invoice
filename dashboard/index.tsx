import { defineDashboardExtension } from '@vendure/dashboard';

import { READ } from './common';
import { InvoiceListPage } from './invoice-list';
import { LayoutPage } from './layout-page';
import { OrderInvoicesBlock } from './order-invoices-block';
import { SettingsPage } from './settings-page';

defineDashboardExtension({
  routes: [
    {
      path: '/e-invoices',
      loader: () => ({ breadcrumb: 'E-Invoices' }),
      navMenuItem: { sectionId: 'sales', id: 'e-invoices', title: 'E-Invoices', url: '/e-invoices', requiresPermission: READ },
      component: (route) => <InvoiceListPage route={route} />,
    },
    {
      path: '/e-invoices/settings',
      loader: () => ({ breadcrumb: [{ path: '/e-invoices', label: 'E-Invoices' }, 'Settings'] }),
      navMenuItem: {
        sectionId: 'settings',
        id: 'e-invoice-settings',
        title: 'E-Invoices',
        url: '/e-invoices/settings',
        requiresPermission: READ,
      },
      component: () => <SettingsPage />,
    },
    {
      path: '/e-invoices/layout',
      loader: () => ({ breadcrumb: [{ path: '/e-invoices/settings', label: 'E-Invoices' }, 'Invoice layout'] }),
      navMenuItem: {
        sectionId: 'settings',
        id: 'e-invoice-layout',
        title: 'Invoice layout',
        url: '/e-invoices/layout',
        requiresPermission: READ,
      },
      component: () => <LayoutPage />,
    },
  ],
  pageBlocks: [
    {
      id: 'e-invoices',
      title: 'E-Invoices',
      location: { pageId: 'order-detail', column: 'main', position: { blockId: 'payment-details', order: 'after' } },
      requiresPermission: READ,
      component: ({ context }) => (context.entity?.id ? <OrderInvoicesBlock orderId={context.entity.id} /> : null),
    },
  ],
});
