import { DefaultLogger, dummyPaymentHandler, LogLevel, mergeConfig, VendureConfig } from '@vendure/core';
import { PostgresInitializer, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import path from 'path';

import { EInvoicePlugin, EInvoicePluginOptions } from '../src';

export const TEST_SECRET = 'test-secret-test-secret-test-secret-123';

/** `TEST_DB=postgres` runs against the docker compose Postgres (row-locking tests, dev server). */
export const usePostgres = process.env.TEST_DB === 'postgres';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));
registerInitializer('postgres', new PostgresInitializer());

const postgresConnection: VendureConfig['dbConnectionOptions'] = {
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'vendure',
  password: process.env.DB_PASSWORD ?? 'vendure',
  synchronize: true,
};

export function createConfig(
  options: Partial<EInvoicePluginOptions> = {},
  overrides: Partial<VendureConfig> = {},
): Required<VendureConfig> {
  return mergeConfig(testConfig, {
    logger: new DefaultLogger({ level: LogLevel.Error }),
    paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] },
    ...(usePostgres ? { dbConnectionOptions: postgresConnection } : {}),
    // `TEST_PORT` lets the e2e suites run next to the dev server (which uses the default port)
    ...(process.env.TEST_PORT ? { apiOptions: { port: Number(process.env.TEST_PORT) } } : {}),
    plugins: [EInvoicePlugin.init({ secret: TEST_SECRET, ...options })],
    ...overrides,
  });
}

export const fixtures = {
  productsCsvPath: path.join(__dirname, 'fixtures/products.csv'),
};
