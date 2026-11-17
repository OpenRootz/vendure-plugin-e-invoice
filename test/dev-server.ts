// Local dev server: fresh Postgres DB (docker compose) seeded with a German shop (EUR, German) + the plugin.
//   pnpm db:up && pnpm dev     → http://localhost:3050/admin-api, /shop-api
//   pnpm dashboard:build first → the dashboard with the plugin's extension at /dashboard
//   Emails (sending of documents) land in the dev mailbox at /mailbox
// Set TEST_DB=sqljs to run without Docker.
process.env.TEST_DB ??= 'postgres';

import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { DefaultLogger, DefaultSearchPlugin, LogLevel } from '@vendure/core';
import { DashboardPlugin } from '@vendure/dashboard/plugin';
import { EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import fs from 'fs';
import path from 'path';
import { createTestEnvironment, SimpleGraphQLClient } from '@vendure/testing';
import gql from 'graphql-tag';

import { eInvoiceDeliveryHandler } from '../src/email';

import { prepareEmailTemplates } from './email-templates';
import { initialData } from './fixtures/initial-data';
import { createConfig, fixtures } from './helpers';

(async () => {
  const port = Number(process.env.TEST_PORT ?? 3050);
  const config = createConfig(
    // Emails are sent from jobs, outside of a request: links need the public URL
    { downloadLinks: { baseUrl: `http://localhost:${port}` } },
    { logger: new DefaultLogger({ level: LogLevel.Info }) },
  );
  // The dashboard's global search and product lists need a search plugin
  config.plugins.push(DefaultSearchPlugin.init({ bufferUpdates: false }));
  // Real asset storage (the test config keeps no files), so logos can be uploaded and rendered
  config.plugins.push(AssetServerPlugin.init({ route: 'assets', assetUploadDir: path.join(__dirname, '__output__/assets') }));
  config.plugins.push(
    EmailPlugin.init({
      devMode: true,
      route: 'mailbox',
      outputPath: path.join(__dirname, '__output__/emails'),
      handlers: [eInvoiceDeliveryHandler],
      templateLoader: new FileBasedTemplateLoader(prepareEmailTemplates(path.join(__dirname, '__output__/email-templates'))),
      globalTemplateVars: { fromAddress: '"Demo Shop" <noreply@example.com>' },
    }),
  );
  const dashboardDir = path.join(__dirname, '__output__/dashboard');
  if (fs.existsSync(path.join(dashboardDir, 'index.html'))) {
    config.plugins.push(DashboardPlugin.init({ route: 'dashboard', appDir: dashboardDir }));
  }
  const { server, adminClient } = createTestEnvironment(config);
  await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 5 });
  await useGermanChannel(adminClient);
  console.log(`\nVendure dev server running on http://localhost:${config.apiOptions.port}`);
  console.log(
    'Admin API: /admin-api  ·  Shop API: /shop-api  ·  Dashboard: /dashboard  ·  Mailbox: /mailbox  ·  superadmin / superadmin\n',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Vendure creates the default channel with USD and the configured default language (English in the test config);
 * the initial data cannot change that. The prices of the imported products follow the new currency.
 */
async function useGermanChannel(adminClient: SimpleGraphQLClient) {
  await adminClient.asSuperAdmin();
  await adminClient.query(gql`
    mutation {
      updateGlobalSettings(input: { availableLanguages: [de, en] }) {
        ... on GlobalSettings {
          id
        }
      }
    }
  `);
  const { activeChannel } = await adminClient.query(gql`
    query {
      activeChannel {
        id
      }
    }
  `);
  const { updateChannel } = await adminClient.query(
    gql`
      mutation ($input: UpdateChannelInput!) {
        updateChannel(input: $input) {
          ... on Channel {
            defaultCurrencyCode
            defaultLanguageCode
          }
          ... on ErrorResult {
            message
          }
        }
      }
    `,
    {
      input: {
        id: activeChannel.id,
        defaultCurrencyCode: 'EUR',
        availableCurrencyCodes: ['EUR'],
        defaultLanguageCode: 'de',
        availableLanguageCodes: ['de', 'en'],
      },
    },
  );
  if (updateChannel.message) throw new Error(updateChannel.message);
  await reindexSearch(adminClient);
}

/** The search index was built during seeding in English; without a reindex the German dashboard finds nothing. */
async function reindexSearch(adminClient: SimpleGraphQLClient) {
  const { reindex } = await adminClient.query(gql`
    mutation {
      reindex {
        id
      }
    }
  `);
  for (let attempt = 0; attempt < 100; attempt++) {
    const { job } = await adminClient.query(
      gql`
        query ($id: ID!) {
          job(jobId: $id) {
            state
            error
          }
        }
      `,
      { id: reindex.id },
    );
    if (job.state === 'COMPLETED') return;
    if (job.state === 'FAILED' || job.state === 'CANCELLED') {
      throw new Error(`Search reindex ${job.state}: ${JSON.stringify(job.error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Search reindex did not finish in time');
}
