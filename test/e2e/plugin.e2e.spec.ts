import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../fixtures/initial-data';
import { createConfig, fixtures } from '../helpers';

describe('EInvoicePlugin (scaffold)', () => {
  const { server, adminClient } = createTestEnvironment(createConfig());

  beforeAll(async () => {
    await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 2 });
    await adminClient.asSuperAdmin();
  });

  afterAll(async () => {
    await server.destroy();
  });

  it('boots Vendure with the plugin and seeded German tax rates', async () => {
    const { taxRates } = await adminClient.query(gql`
      query {
        taxRates {
          items {
            name
            value
          }
        }
      }
    `);
    const values = taxRates.items.map((t: { value: number }) => t.value);
    expect(values).toEqual(expect.arrayContaining([19, 7, 0]));
  });

  it('registers Create, Read and Update permissions but no DeleteEInvoice', async () => {
    const { globalSettings } = await adminClient.query(gql`
      query {
        globalSettings {
          serverConfig {
            permissions {
              name
              assignable
            }
          }
        }
      }
    `);
    const names = globalSettings.serverConfig.permissions
      .map((p: { name: string }) => p.name)
      .filter((name: string) => name.endsWith('EInvoice'));
    expect(names).toEqual(['CreateEInvoice', 'ReadEInvoice', 'UpdateEInvoice']);
  });
});
