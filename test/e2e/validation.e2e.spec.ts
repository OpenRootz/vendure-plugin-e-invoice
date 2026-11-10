import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EInvoicePlugin, InvoiceValidator, ValidationInput, ValidationReport } from '../../src';
import { initialData } from '../fixtures/initial-data';
import { createConfig, fixtures } from '../helpers';

import { E_INVOICE_FIELDS, InvoiceResult, placeOrder, RETRY_INVOICE, SELLER_SETTINGS, UPDATE_SETTINGS, waitForInvoices } from './helpers';

/** Rejects documents while `rejecting` is set; throws while `down` is set. */
class FakeValidator implements InvoiceValidator {
  rejecting = false;
  down = false;
  seen: ValidationInput[] = [];
  async validate(_ctx: unknown, input: ValidationInput): Promise<ValidationReport> {
    this.seen.push(input);
    if (this.down) throw new Error('connect ECONNREFUSED');
    return this.rejecting
      ? { valid: false, validator: 'fake', messages: [{ level: 'error', code: 'BR-CO-16', text: 'Amount due is wrong' }] }
      : { valid: true, validator: 'fake', messages: [] };
  }
}

const VALIDATION = gql`
  query ($id: ID!) {
    eInvoice(id: $id) {
      ...EInvoiceFields
      validation {
        mode
        valid
        error
        results {
          format
          valid
          validator
          messages {
            level
            code
            text
          }
        }
      }
    }
  }
  ${E_INVOICE_FIELDS}
`;

const issued = (invoices: InvoiceResult[]) => invoices.length > 0 && invoices.every((i) => i.status === 'ISSUED');

describe('Runtime validation', () => {
  const validator = new FakeValidator();
  const { server, adminClient, shopClient } = createTestEnvironment(createConfig({ validation: { validator, mode: 'enforce' } }));

  beforeAll(async () => {
    await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 1 });
    await adminClient.asSuperAdmin();
    await adminClient.query(UPDATE_SETTINGS, { input: SELLER_SETTINGS });
  });

  afterAll(async () => {
    await server.destroy();
  });

  it('validates every file and stores the result', async () => {
    const order = await placeOrder(shopClient, {
      items: [{ sku: 'KAF-500', quantity: 1 }],
      customFields: { eInvoiceLeitwegId: '04011000-1234512345-06' },
    });
    const [invoice] = await waitForInvoices(adminClient, order.id, issued);
    const { eInvoice } = await adminClient.query(VALIDATION, { id: invoice.id });
    expect(eInvoice.validation).toMatchObject({
      mode: 'enforce',
      valid: true,
      error: null,
      results: [
        { format: 'ZUGFERD', valid: true, validator: 'fake' },
        { format: 'XRECHNUNG_CII', valid: true, validator: 'fake' },
      ],
    });
    // The PDF is validated through its embedded XML
    const pdf = validator.seen.find((s) => s.format === 'zugferd');
    expect(pdf?.data.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf?.xml).toContain('<rsm:CrossIndustryInvoice');
  });

  it('enforce: a rejected document is FAILED and issued after a retry', async () => {
    validator.rejecting = true;
    const order = await placeOrder(shopClient, { items: [{ sku: 'BOOK-1', quantity: 1 }] });
    const [failed] = await waitForInvoices(adminClient, order.id, (i) => i[0]?.status === 'FAILED');
    expect(failed.errorMessage).toBe('Validation failed: BR-CO-16: Amount due is wrong');
    expect(failed.files).toEqual([]);
    const { eInvoice } = await adminClient.query(VALIDATION, { id: failed.id });
    expect(eInvoice.validation).toMatchObject({ valid: false, results: [{ valid: false, messages: [{ code: 'BR-CO-16' }] }] });

    validator.rejecting = false;
    await adminClient.query(RETRY_INVOICE, { id: failed.id });
    const [retried] = await waitForInvoices(adminClient, order.id, issued);
    expect(retried.number).toBe(failed.number);
  });

  it('enforce: an unreachable validator fails the document', async () => {
    validator.down = true;
    const order = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 1 }] });
    const [failed] = await waitForInvoices(adminClient, order.id, (i) => i[0]?.status === 'FAILED');
    expect(failed.errorMessage).toBe('Validation failed: connect ECONNREFUSED');
    validator.down = false;
  });

  it('report: issues the document anyway and keeps the result', async () => {
    EInvoicePlugin.options.validation.mode = 'report';
    validator.rejecting = true;
    try {
      const order = await placeOrder(shopClient, { items: [{ sku: 'NB-A5', quantity: 2 }] });
      const [invoice] = await waitForInvoices(adminClient, order.id, issued);
      const { eInvoice } = await adminClient.query(VALIDATION, { id: invoice.id });
      expect(eInvoice.validation).toMatchObject({ mode: 'report', valid: false, results: [{ messages: [{ code: 'BR-CO-16' }] }] });
    } finally {
      EInvoicePlugin.options.validation.mode = 'enforce';
      validator.rejecting = false;
    }
  });
});
