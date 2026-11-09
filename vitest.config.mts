import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // e2e suites boot a full Vendure server each; keep them isolated
    fileParallelism: false,
  },
  plugins: [
    // Vendure/Nest rely on decorator metadata, which esbuild does not emit
    swc.vite({ jsc: { transform: { useDefineForClassFields: false } } }),
  ],
});
