/* eslint-disable no-console */
// Local dev server: fresh Postgres DB (docker compose) seeded with a German shop + the plugin.
//   pnpm db:up && pnpm dev     → http://localhost:3050/admin-api, /shop-api
// Set TEST_DB=sqljs to run without Docker.
process.env.TEST_DB ??= 'postgres';

import { DefaultLogger, LogLevel } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';

import { initialData } from './fixtures/initial-data';
import { createConfig, fixtures } from './helpers';

(async () => {
  const config = createConfig({}, { logger: new DefaultLogger({ level: LogLevel.Info }) });
  const { server } = createTestEnvironment(config);
  await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 5 });
  console.log(`\nVendure dev server running on http://localhost:${config.apiOptions.port}`);
  console.log('Admin API: /admin-api  ·  Shop API: /shop-api  ·  superadmin / superadmin\n');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
