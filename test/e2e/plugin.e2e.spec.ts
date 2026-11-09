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
});
