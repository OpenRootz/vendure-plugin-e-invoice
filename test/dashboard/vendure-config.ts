// Minimal Vendure config for building the dashboard with the plugin's extension (`pnpm dashboard:build`).
// The dashboard build only reads the plugin list and the schema from it; it never connects to the database.
import { VendureConfig } from '@vendure/core';
import { DashboardPlugin } from '@vendure/dashboard/plugin';
import path from 'path';

import { EInvoicePlugin } from '../../src';

export const config: VendureConfig = {
  apiOptions: { port: 3050 },
  authOptions: { tokenMethod: ['bearer', 'cookie'] },
  dbConnectionOptions: { type: 'sqljs', synchronize: false },
  paymentOptions: { paymentMethodHandlers: [] },
  plugins: [
    EInvoicePlugin.init({ secret: 'dashboard-build-only-secret-0000000000' }),
    DashboardPlugin.init({ route: 'dashboard', appDir: path.join(__dirname, '../__output__/dashboard') }),
  ],
};
