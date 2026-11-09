import { CrudPermissionDefinition } from '@vendure/core';

export const PLUGIN_INIT_OPTIONS = Symbol('E_INVOICE_PLUGIN_OPTIONS');
export const loggerCtx = 'EInvoicePlugin';
export const E_INVOICE_QUEUE = 'e-invoice';

/** CreateEInvoice, ReadEInvoice, UpdateEInvoice (retry, void, settings), DeleteEInvoice (unused) */
export const eInvoicePermission = new CrudPermissionDefinition('EInvoice');
