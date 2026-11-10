import { createTestEnvironment } from '@vendure/testing';
import gql from 'graphql-tag';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../fixtures/initial-data';
import { createConfig, fixtures } from '../helpers';
import { extractFacturX } from '../pdf-utils';

import {
  E_INVOICE_FIELDS,
  InvoiceResult,
  placeOrder,
  readFiles,
  RETRY_INVOICE,
  SELLER_SETTINGS,
  UPDATE_SETTINGS,
  waitForInvoices,
  writeOutput,
} from './helpers';

const year = new Date().getFullYear();
const re = (n: number) => `RE-${year}-${String(n).padStart(5, '0')}`;
const gs = (n: number) => `GS-${year}-${String(n).padStart(5, '0')}`;
const settled = (count: number) => (invoices: InvoiceResult[]) =>
  invoices.length === count && invoices.every((i) => i.status === 'ISSUED' || i.status === 'BLOCKED');

const ORDER = gql`
  query ($id: ID!) {
    order(id: $id) {
      id
      state
      totalWithTax
      lines {
        id
        quantity
        productVariant {
          sku
        }
      }
      payments {
        id
        amount
      }
    }
  }
`;

const INVOICE = gql`
  query ($id: ID!) {
    eInvoice(id: $id) {
      ...EInvoiceFields
      remainingAmount
      correctedInvoice {
        number
      }
      creditNotes {
        number
        totalWithTax
      }
    }
  }
  ${E_INVOICE_FIELDS}
`;

const CREATE_CREDIT_NOTE = gql`
  mutation ($input: CreateEInvoiceCreditNoteInput!) {
    createEInvoiceCreditNote(input: $input) {
      ...EInvoiceFields
    }
  }
  ${E_INVOICE_FIELDS}
`;

const CANCEL_AND_REISSUE = gql`
  mutation ($invoiceId: ID!) {
    cancelAndReissueEInvoice(invoiceId: $invoiceId) {
      ...EInvoiceFields
    }
  }
  ${E_INVOICE_FIELDS}
`;

const REFUND_ORDER = gql`
  mutation ($input: RefundOrderInput!) {
    refundOrder(input: $input) {
      ... on Refund {
        id
        state
      }
      ... on ErrorResult {
        errorCode
        message
      }
    }
  }
`;

const SETTLE_REFUND = gql`
  mutation ($id: ID!) {
    settleRefund(input: { id: $id, transactionId: "tx" }) {
      ... on Refund {
        id
        state
      }
      ... on ErrorResult {
        errorCode
        message
      }
    }
  }
`;

const TRANSITION = gql`
  mutation ($id: ID!, $state: String!) {
    transitionOrderToState(id: $id, state: $state) {
      ... on Order {
        id
        state
      }
      ... on OrderStateTransitionError {
        errorCode
        message
        transitionError
      }
    }
  }
`;

interface OrderResult {
  id: string;
  state: string;
  totalWithTax: number;
  lines: { id: string; quantity: number; productVariant: { sku: string } }[];
  payments: { id: string; amount: number }[];
}

type Invoice = InvoiceResult & {
  remainingAmount: number;
  correctedInvoice: { number: string } | null;
  creditNotes: { number: string; totalWithTax: number }[];
};

describe('Credit notes', () => {
  const { server, adminClient, shopClient } = createTestEnvironment(createConfig());

  const getOrder = async (id: string): Promise<OrderResult> => (await adminClient.query(ORDER, { id })).order;
  const getInvoice = async (id: string): Promise<Invoice> => (await adminClient.query(INVOICE, { id })).eInvoice;
  const refund = async (orderId: string, amount: number) => {
    const order = await getOrder(orderId);
    const { refundOrder } = await adminClient.query(REFUND_ORDER, { input: { paymentId: order.payments[0].id, amount } });
    if (refundOrder.errorCode) throw new Error(refundOrder.message);
    const { settleRefund } = await adminClient.query(SETTLE_REFUND, { id: refundOrder.id });
    expect(settleRefund.state).toBe('Settled');
  };
  const issuedOrder = async () => {
    const order = await placeOrder(shopClient, {
      items: [
        { sku: 'KAF-500', quantity: 2 },
        { sku: 'BOOK-1', quantity: 1 },
      ],
      customFields: { eInvoiceVatId: 'DE987654321' },
    });
    const [invoice] = await waitForInvoices(adminClient, order.id, settled(1));
    expect(invoice.status).toBe('ISSUED');
    return { order, invoice };
  };

  beforeAll(async () => {
    await server.init({ initialData, productsCsvPath: fixtures.productsCsvPath, customerCount: 1 });
    await adminClient.asSuperAdmin();
    await adminClient.query(UPDATE_SETTINGS, { input: SELLER_SETTINGS });
  });

  afterAll(async () => {
    await server.destroy();
  });

  describe('refunds, manual credit notes and cancellation of one order', () => {
    let order: { id: string; code: string };
    let invoice: InvoiceResult;

    it('issues the invoice', async () => {
      ({ order, invoice } = await issuedOrder());
      expect(invoice.number).toBe(re(1));
      // 2 × 11.90 + 20.00 + 5.83 shipping
      expect(invoice.totalWithTax).toBe(2380 + 2000 + 583);
    });

    it('creates a credit note for a settled amount-only refund, split by VAT rate', async () => {
      await refund(order.id, 1000);
      const docs = await waitForInvoices(adminClient, order.id, settled(2));
      const note = docs[1];
      expect(note).toMatchObject({ type: 'CREDIT_NOTE', status: 'ISSUED', reason: 'refund', number: gs(1), totalWithTax: 1000 });
      expect(note.files.map((f) => f.fileName)).toEqual([`${gs(1)}.pdf`]);

      const pdf = (await readFiles(server, gs(1))).zugferd;
      writeOutput('credit-refund.pdf', pdf);
      const xml = extractFacturX(pdf);
      writeOutput('credit-refund.zugferd.xml', xml);
      expect(xml).toContain('<ram:TypeCode>381</ram:TypeCode>');
      expect(xml).toContain(`<ram:IssuerAssignedID>${re(1)}</ram:IssuerAssignedID>`);
      expect(xml).toContain('<ram:DuePayableAmount>0.00</ram:DuePayableAmount>');
      // 19 %: 2380 + 583 = 2963, 7 %: 2000 → 1000 × 2963 / 4963 = 597, rest 403
      expect(xml).toContain('<ram:GrandTotalAmount>10.00</ram:GrandTotalAmount>');
      expect(xml).toMatch(/<ram:LineTotalAmount>5\.02<\/ram:LineTotalAmount>[\s\S]*<ram:LineTotalAmount>3\.77<\/ram:LineTotalAmount>/);

      const details = await getInvoice(invoice.id);
      expect(details.remainingAmount).toBe(invoice.totalWithTax - 1000);
      expect(details.creditNotes).toEqual([{ number: gs(1), totalWithTax: 1000 }]);
      expect((await getInvoice(note.id)).correctedInvoice).toEqual({ number: re(1) });
    });

    it('creates a manual credit note for returned items at the invoiced price', async () => {
      const coffee = (await getOrder(order.id)).lines.find((l) => l.productVariant.sku === 'KAF-500')!;
      const { createEInvoiceCreditNote } = await adminClient.query(CREATE_CREDIT_NOTE, {
        input: { invoiceId: invoice.id, lines: [{ orderLineId: coffee.id, quantity: 1 }], note: 'Retoure 1 × Kaffee' },
      });
      expect(createEInvoiceCreditNote).toMatchObject({ status: 'PENDING', reason: 'manual', number: gs(2), totalNet: 1000, totalWithTax: 1190 });
      await waitForInvoices(adminClient, order.id, settled(3));
      const xml = extractFacturX((await readFiles(server, gs(2))).zugferd);
      expect(xml).toContain('<ram:Content>Retoure 1 × Kaffee</ram:Content>');
    });

    it('never credits more than was invoiced', async () => {
      const coffee = (await getOrder(order.id)).lines.find((l) => l.productVariant.sku === 'KAF-500')!;
      const error = await adminClient
        .query(CREATE_CREDIT_NOTE, { input: { invoiceId: invoice.id, lines: [{ orderLineId: coffee.id, quantity: 2 }] } })
        .catch((e: Error) => e.message);
      expect(error).toContain('2 requested, 1 left to credit');
      const tooMuch = await adminClient
        .query(CREATE_CREDIT_NOTE, { input: { invoiceId: invoice.id, amount: invoice.totalWithTax } })
        .catch((e: Error) => e.message);
      expect(tooMuch).toContain('exceeds what is left to credit');
    });

    it('shows what can still be credited per line', async () => {
      const { lines } = await getOrder(order.id);
      const coffee = lines.find((l) => l.productVariant.sku === 'KAF-500')!;
      const { eInvoice } = await adminClient.query(
        gql`
          query ($id: ID!) {
            eInvoice(id: $id) {
              creditable {
                remainingTotal
                chargesGross
                lines {
                  orderLineId
                  sku
                  invoicedQuantity
                  remainingQuantity
                  remainingGross
                }
              }
            }
          }
        `,
        { id: invoice.id },
      );
      expect(eInvoice.creditable).toMatchObject({ remainingTotal: invoice.totalWithTax - 1000 - 1190, chargesGross: 583 });
      expect(eInvoice.creditable.lines).toContainEqual({
        orderLineId: coffee.id,
        sku: 'KAF-500',
        invoicedQuantity: 2,
        remainingQuantity: 1,
        remainingGross: 1190,
      });
    });

    it('credits the remaining amount when the order is cancelled', async () => {
      const { cancelOrder } = await adminClient.query(
        gql`
          mutation ($id: ID!) {
            cancelOrder(input: { orderId: $id, cancelShipping: true }) {
              ... on Order {
                state
              }
              ... on ErrorResult {
                message
              }
            }
          }
        `,
        { id: order.id },
      );
      expect(cancelOrder.state).toBe('Cancelled');
      const docs = await waitForInvoices(adminClient, order.id, settled(4));
      expect(docs[3]).toMatchObject({ type: 'CREDIT_NOTE', reason: 'cancellation', number: gs(3) });
      expect(docs[3].totalWithTax).toBe(invoice.totalWithTax - 1000 - 1190);
      expect((await getInvoice(invoice.id)).remainingAmount).toBe(0);
      const pdf = (await readFiles(server, gs(3))).zugferd;
      writeOutput('credit-cancellation.pdf', pdf);
      writeOutput('credit-cancellation.zugferd.xml', extractFacturX(pdf));
    });

    it('does not credit a refund of an invoice that is already fully credited', async () => {
      await refund(order.id, 500);
      await new Promise((r) => setTimeout(r, 1000));
      expect(await waitForInvoices(adminClient, order.id, settled(4))).toHaveLength(4);
    });
  });

  it('blocks a refund credit note that exceeds the invoice, and shows why', async () => {
    const { order, invoice } = await issuedOrder();
    await adminClient.query(CREATE_CREDIT_NOTE, { input: { invoiceId: invoice.id, amount: invoice.totalWithTax - 100 } });
    await waitForInvoices(adminClient, order.id, settled(2));
    await refund(order.id, 500);
    const docs = await waitForInvoices(adminClient, order.id, settled(3));
    expect(docs[2]).toMatchObject({ type: 'CREDIT_NOTE', status: 'BLOCKED', reason: 'refund', number: null, totalWithTax: 500 });
    expect(docs[2].issues).toEqual([expect.objectContaining({ code: 'AMOUNT_EXCEEDED' })]);
    const { retryEInvoice } = await adminClient.query(RETRY_INVOICE, { id: docs[2].id });
    expect(retryEInvoice.status).toBe('BLOCKED');
  });

  it('cancels and reissues an invoice on request', async () => {
    const { order, invoice } = await issuedOrder();
    const { cancelAndReissueEInvoice } = await adminClient.query(CANCEL_AND_REISSUE, { invoiceId: invoice.id });
    expect(cancelAndReissueEInvoice).toMatchObject({ type: 'INVOICE', reason: 'manual', totalWithTax: invoice.totalWithTax });
    const docs = await waitForInvoices(adminClient, order.id, settled(3));
    expect(docs.map((d) => [d.type, d.number])).toEqual([
      ['INVOICE', invoice.number],
      ['CREDIT_NOTE', expect.stringMatching(/^GS-/)],
      ['INVOICE', cancelAndReissueEInvoice.number],
    ]);
    const pdf = (await readFiles(server, docs[1].number!)).zugferd;
    expect(extractFacturX(pdf)).toContain(`<ram:IssuerAssignedID>${invoice.number}</ram:IssuerAssignedID>`);
    // The original can no longer be credited or reissued
    const error = await adminClient.query(CANCEL_AND_REISSUE, { invoiceId: invoice.id }).catch((e: Error) => e.message);
    expect(error).toContain('has been replaced');
  });

  it('replaces the invoice when the order is modified (Q6), without crediting the modification refund twice', async () => {
    const { order, invoice } = await issuedOrder();
    const before = await getOrder(order.id);
    const coffee = before.lines.find((l) => l.productVariant.sku === 'KAF-500')!;

    expect((await adminClient.query(TRANSITION, { id: order.id, state: 'Modifying' })).transitionOrderToState.state).toBe('Modifying');
    const { modifyOrder } = await adminClient.query(
      gql`
        mutation ($input: ModifyOrderInput!) {
          modifyOrder(input: $input) {
            ... on Order {
              totalWithTax
              modifications {
                refund {
                  id
                }
              }
            }
            ... on ErrorResult {
              errorCode
              message
            }
          }
        }
      `,
      {
        input: {
          dryRun: false,
          orderId: order.id,
          adjustOrderLines: [{ orderLineId: coffee.id, quantity: 1 }],
          refunds: [{ paymentId: before.payments[0].id, reason: 'one coffee less' }],
        },
      },
    );
    expect(modifyOrder.errorCode).toBeUndefined();
    expect(modifyOrder.totalWithTax).toBe(before.totalWithTax - 1190);
    const back = await adminClient.query(TRANSITION, { id: order.id, state: 'PaymentSettled' });
    expect(back.transitionOrderToState.state).toBe('PaymentSettled');
    await adminClient.query(SETTLE_REFUND, { id: modifyOrder.modifications[0].refund.id });

    const docs = await waitForInvoices(adminClient, order.id, settled(3));
    expect(docs.map((d) => [d.type, d.reason, d.totalWithTax])).toEqual([
      ['INVOICE', 'auto', before.totalWithTax],
      ['CREDIT_NOTE', 'modification', before.totalWithTax],
      ['INVOICE', 'modification', before.totalWithTax - 1190],
    ]);
    // the refund of the modification is documented by the new invoice, not by another credit note
    await new Promise((r) => setTimeout(r, 1000));
    expect(await waitForInvoices(adminClient, order.id, settled(3))).toHaveLength(3);

    const reissued = (await readFiles(server, docs[2].number!)).zugferd;
    writeOutput('modification-reissued.pdf', reissued);
    writeOutput('modification-credit.pdf', (await readFiles(server, docs[1].number!)).zugferd);
    // paid more than the new total: the difference was refunded, nothing is due
    expect(extractFacturX(reissued)).toContain('<ram:DuePayableAmount>0.00</ram:DuePayableAmount>');
    expect((await getInvoice(invoice.id)).remainingAmount).toBe(0);
  });
});
