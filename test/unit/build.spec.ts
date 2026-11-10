import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');

// With `useDefineForClassFields` (the default for ES2022 targets), class field declarations would reset the
// values that VendureEntity's constructor assigns, e.g. `new EInvoice({ status: 'PENDING' }).status === undefined`.
describe('build output', () => {
  it('keeps class field semantics compatible with VendureEntity', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.useDefineForClassFields).toBe(false);
  });

  it.runIf(fs.existsSync(path.join(root, 'dist/index.js')))('entities built to dist keep their constructor input', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dist = require(path.join(root, 'dist'));
    const settings = new dist.EInvoiceChannelSettings({ enabled: true, autoIssue: false, seller: {}, payment: {}, layout: {} });
    expect(settings).toMatchObject({ enabled: true, autoIssue: false, layout: {} });
    expect(new dist.EInvoice({ status: 'PENDING', type: 'invoice' })).toMatchObject({ status: 'PENDING', type: 'invoice' });
  });
});
