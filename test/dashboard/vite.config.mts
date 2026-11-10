import { vendureDashboardPlugin } from '@vendure/dashboard/vite';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { defineConfig } from 'vite';

// Builds the Vendure dashboard including this plugin's extension into test/__output__/dashboard,
// served by the dev server at http://localhost:3050/dashboard (`pnpm dashboard:build && pnpm dev`).
export default defineConfig({
  root: join(__dirname, '../..'),
  base: '/dashboard',
  build: { outDir: join(__dirname, '../__output__/dashboard'), emptyOutDir: true },
  plugins: [
    vendureDashboardPlugin({
      vendureConfigPath: pathToFileURL(join(__dirname, 'vendure-config.ts')),
      api: { host: 'auto', port: 'auto' },
      gqlOutputPath: join(__dirname, '../__output__/gql'),
    }),
  ],
});
