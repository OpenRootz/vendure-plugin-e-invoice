/* eslint-disable no-console */
// Local dev server: fresh Postgres DB (docker compose) seeded with a German shop + the plugin.
//   pnpm db:up && pnpm dev     → http://localhost:3050/admin-api, /shop-api
//   pnpm dashboard:build first → the dashboard with the plugin's extension at /dashboard
// Set TEST_DB=sqljs to run without Docker.
process.env.TEST_DB ??= 'postgres';

import { DefaultLogger, LogLevel } from '@vendure/core';
import { DashboardPlugin } from '@vendure/dashboard/plugin';
import fs from 'fs';
import path from 'path';
import { createTestEnvironment } from '@vendure/testing';

import { initialData } from './fixtures/initial-data';
import { createConfig, fixtures } from './helpers';

(async () => {
  const config = createConfig({}, { logger: new DefaultLogger({ level: LogLevel.Info }) });
  const dashboardDir = path.join(__dirname, '__output__/dashboard');
  if (fs.existsSync(path.join(dashboardDir, 'index.html'))) {
    config.plugins.push(DashboardPlugin.init({ route: 'dashboard', appDir: dashboardDir }));
  }
  const { server } = createTestEnvironment(config);
  await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 5 });
  console.log(`\nVendure dev server running on http://localhost:${config.apiOptions.port}`);
  console.log('Admin API: /admin-api  ·  Shop API: /shop-api  ·  Dashboard: /dashboard  ·  superadmin / superadmin\n');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
