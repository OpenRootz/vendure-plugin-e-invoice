import { PermissionDefinition } from '@vendure/core';

export const PLUGIN_INIT_OPTIONS = Symbol('E_INVOICE_PLUGIN_OPTIONS');
export const loggerCtx = 'EInvoicePlugin';
export const E_INVOICE_QUEUE = 'e-invoice';

// Single definitions instead of a CRUD definition: issued invoices are never deleted, so there is no DeleteEInvoice.
// The dashboard's role editor still groups them as "EInvoice" by name, with the first description (minus its verb)
// as the group description.
const create = new PermissionDefinition({
  name: 'CreateEInvoice',
  description: 'Grants permission to issue invoices and credit notes',
});
const read = new PermissionDefinition({
  name: 'ReadEInvoice',
  description: 'Grants permission to view and download invoices and credit notes',
});
const update = new PermissionDefinition({
  name: 'UpdateEInvoice',
  description: 'Grants permission to retry and void documents and to change the e-invoice settings and layout',
});

export const eInvoicePermissionDefinitions = [create, read, update];

/** CreateEInvoice, ReadEInvoice, UpdateEInvoice (retry, void, settings) */
export const eInvoicePermission = {
  Create: create.Permission,
  Read: read.Permission,
  Update: update.Permission,
} as const;
