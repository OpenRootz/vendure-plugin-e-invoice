import fs from 'fs';
import path from 'path';

/**
 * Builds an EmailPlugin template directory like a shop has it: Vendure's partials (header, footer) plus the
 * template of this package. Returns the directory.
 */
export function prepareEmailTemplates(dir: string): string {
  fs.rmSync(dir, { recursive: true, force: true });
  const vendureTemplates = path.join(path.dirname(require.resolve('@vendure/email-plugin/package.json')), 'templates');
  fs.cpSync(path.join(vendureTemplates, 'partials'), path.join(dir, 'partials'), { recursive: true });
  fs.cpSync(path.join(__dirname, '../templates/e-invoice-delivery'), path.join(dir, 'e-invoice-delivery'), { recursive: true });
  return dir;
}
