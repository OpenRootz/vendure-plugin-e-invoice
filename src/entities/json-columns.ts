import { getMetadataArgsStorage } from 'typeorm';

import { EInvoiceChannelSettings } from './e-invoice-channel-settings.entity';
import { EInvoice } from './e-invoice.entity';

/** Databases on which TypeORM stores `simple-json` as `TEXT`, which holds at most 64 KB. */
const LONGTEXT_DATABASES = ['mysql', 'mariadb'];

const json = {
  to: (value: unknown) => (value === undefined || value === null ? value : JSON.stringify(value)),
  from: (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value),
};

/**
 * On MySQL / MariaDB the JSON columns of the plugin (invoice snapshot, layout, …) become `LONGTEXT`: a `TEXT`
 * column is too small for the snapshot of a large order or a layout with many text blocks. Other databases
 * keep `simple-json` (unlimited `text`). Called at bootstrap, once the database type is known.
 */
export function adaptJsonColumns(dbType: string): void {
  if (!LONGTEXT_DATABASES.includes(dbType)) return;
  const targets: unknown[] = [EInvoice, EInvoiceChannelSettings];
  for (const column of getMetadataArgsStorage().columns) {
    if (!targets.includes(column.target) || column.options.type !== 'simple-json') continue;
    column.options.type = 'longtext';
    column.options.transformer = json;
  }
}
