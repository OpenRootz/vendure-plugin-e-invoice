import { getMetadataArgsStorage, ValueTransformer } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { adaptJsonColumns, EInvoice, EInvoiceChannelSettings } from '../../src/entities';

const columns = (target: unknown) => getMetadataArgsStorage().columns.filter((c) => c.target === target);
const column = (target: unknown, name: string) => columns(target).find((c) => c.propertyName === name)!;

describe('JSON columns', () => {
  it('keep simple-json on databases with an unlimited text type', () => {
    adaptJsonColumns('postgres');
    adaptJsonColumns('sqljs');
    expect(column(EInvoice, 'model').options.type).toBe('simple-json');
    expect(column(EInvoiceChannelSettings, 'layout').options.type).toBe('simple-json');
  });

  it('become LONGTEXT with a JSON transformer on MySQL and MariaDB', () => {
    adaptJsonColumns('mysql');
    const json = [...columns(EInvoice), ...columns(EInvoiceChannelSettings)].filter((c) => c.options.transformer);
    expect(json.map((c) => c.propertyName).sort()).toEqual(['formats', 'issues', 'layout', 'model', 'payment', 'seller', 'validation']);
    expect(json.every((c) => c.options.type === 'longtext')).toBe(true);
    expect(column(EInvoice, 'model').options.nullable).toBe(true);

    const transformer = column(EInvoice, 'model').options.transformer as ValueTransformer;
    const value = { lines: [{ id: '1', quantity: '2' }], notes: [] };
    expect(transformer.from(transformer.to(value))).toEqual(value);
    expect(transformer.to(null)).toBeNull();
    expect(transformer.from(null)).toBeNull();
    // idempotent
    adaptJsonColumns('mariadb');
    expect(column(EInvoice, 'model').options.type).toBe('longtext');
  });
});
