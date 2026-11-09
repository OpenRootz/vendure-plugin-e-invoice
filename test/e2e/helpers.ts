import { TransactionalConnection } from '@vendure/core';
import { SimpleGraphQLClient, TestServer } from '@vendure/testing';
import gql from 'graphql-tag';
import fs from 'fs';
import path from 'path';

import { EInvoice, EInvoiceBlob } from '../../src';

export const SELLER_SETTINGS = {
  enabled: true,
  autoIssue: true,
  seller: {
    name: 'Demo Shop GmbH',
    address: { line1: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE' },
    vatId: 'DE123456789',
    contact: { name: 'Buchhaltung', phone: '+49 30 1234567', email: 'buchhaltung@example.com' },
    electronicAddress: { scheme: 'EM', value: 'rechnung@example.com' },
    bank: { iban: 'DE02120300000000202051', bic: 'BYLADEM1001', accountName: 'Demo Shop GmbH' },
  },
  payment: { termsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.', termDays: 14 },
};

export const E_INVOICE_FIELDS = gql`
  fragment EInvoiceFields on EInvoice {
    id
    type
    status
    reason
    number
    issueDate
    currencyCode
    totalNet
    totalTax
    totalWithTax
    formats
    files {
      format
      fileName
      mimeType
      size
      sha256
    }
    issues {
      code
      message
      path
    }
    errorMessage
  }
`;

export const UPDATE_SETTINGS = gql`
  mutation ($input: UpdateEInvoiceChannelSettingsInput!) {
    updateEInvoiceChannelSettings(input: $input) {
      enabled
      autoIssue
      seller
    }
  }
`;

export const ORDER_INVOICES = gql`
  query ($id: ID!) {
    order(id: $id) {
      id
      code
      state
      totalWithTax
      eInvoices {
        ...EInvoiceFields
      }
    }
  }
  ${E_INVOICE_FIELDS}
`;

export const CREATE_INVOICE = gql`
  mutation ($orderId: ID!) {
    createEInvoice(orderId: $orderId) {
      ...EInvoiceFields
    }
  }
  ${E_INVOICE_FIELDS}
`;

export const RETRY_INVOICE = gql`
  mutation ($id: ID!) {
    retryEInvoice(id: $id) {
      ...EInvoiceFields
    }
  }
  ${E_INVOICE_FIELDS}
`;

export interface InvoiceResult {
  id: string;
  type: string;
  status: string;
  reason: string;
  number: string | null;
  issueDate: string | null;
  totalNet: number;
  totalTax: number;
  totalWithTax: number;
  formats: string[];
  files: { format: string; fileName: string; mimeType: string; size: number; sha256: string }[];
  issues: { code: string; message: string; path?: string }[];
  errorMessage: string | null;
}

export interface AddressInput {
  fullName?: string;
  company?: string;
  streetLine1: string;
  postalCode: string;
  city: string;
  countryCode: string;
}

export const GERMAN_COMPANY: AddressInput = {
  fullName: 'Max Einkauf',
  company: 'Beispiel Kunde AG',
  streetLine1: 'Kundenweg 7',
  postalCode: '80331',
  city: 'München',
  countryCode: 'DE',
};

export interface PlaceOrderInput {
  items: { sku: string; quantity: number }[];
  billing?: AddressInput;
  shipping?: AddressInput;
  customFields?: Record<string, string>;
  /** Default: settle the payment (order → PaymentSettled) */
  pay?: boolean;
}

const variantIds = new Map<string, string>();

async function variantId(shopClient: SimpleGraphQLClient, sku: string): Promise<string> {
  if (!variantIds.size) {
    const { products } = await shopClient.query(gql`
      query {
        products {
          items {
            variants {
              id
              sku
            }
          }
        }
      }
    `);
    for (const p of products.items) for (const v of p.variants) variantIds.set(v.sku, v.id);
  }
  const id = variantIds.get(sku);
  if (!id) throw new Error(`Unknown SKU ${sku}`);
  return id;
}

let orderSeq = 0;

/** Places a guest order through the Shop API. Returns the order ID and code. */
export async function placeOrder(shopClient: SimpleGraphQLClient, input: PlaceOrderInput): Promise<{ id: string; code: string }> {
  await shopClient.asAnonymousUser();
  let order: { id: string; code: string } | undefined;
  for (const item of input.items) {
    const { addItemToOrder } = await shopClient.query(
      gql`
        mutation ($id: ID!, $qty: Int!) {
          addItemToOrder(productVariantId: $id, quantity: $qty) {
            ... on Order {
              id
              code
            }
            ... on ErrorResult {
              errorCode
              message
            }
          }
        }
      `,
      { id: await variantId(shopClient, item.sku), qty: item.quantity },
    );
    if (addItemToOrder.errorCode) throw new Error(addItemToOrder.message);
    order = addItemToOrder;
  }
  orderSeq++;
  const billing = input.billing ?? GERMAN_COMPANY;
  await shopClient.query(
    gql`
      mutation ($input: CreateCustomerInput!) {
        setCustomerForOrder(input: $input) {
          ... on Order {
            id
          }
        }
      }
    `,
    { input: { emailAddress: `kunde${orderSeq}-${Date.now()}@example.org`, firstName: 'Max', lastName: 'Einkauf' } },
  );
  await shopClient.query(
    gql`
      mutation ($shipping: CreateAddressInput!, $billing: CreateAddressInput!) {
        setOrderShippingAddress(input: $shipping) {
          ... on Order {
            id
          }
        }
        setOrderBillingAddress(input: $billing) {
          ... on Order {
            id
          }
        }
      }
    `,
    { shipping: input.shipping ?? billing, billing },
  );
  if (input.customFields) {
    await shopClient.query(
      gql`
        mutation ($input: UpdateOrderInput!) {
          setOrderCustomFields(input: $input) {
            ... on Order {
              id
            }
          }
        }
      `,
      { input: { customFields: input.customFields } },
    );
  }
  const { eligibleShippingMethods } = await shopClient.query(gql`
    query {
      eligibleShippingMethods {
        id
      }
    }
  `);
  await shopClient.query(
    gql`
      mutation ($id: [ID!]!) {
        setOrderShippingMethod(shippingMethodId: $id) {
          ... on Order {
            id
          }
        }
      }
    `,
    { id: [eligibleShippingMethods[0].id] },
  );
  if (input.pay !== false) {
    await shopClient.query(gql`
      mutation {
        transitionOrderToState(state: "ArrangingPayment") {
          ... on Order {
            id
          }
        }
      }
    `);
    const { addPaymentToOrder } = await shopClient.query(gql`
      mutation {
        addPaymentToOrder(input: { method: "test-payment", metadata: {} }) {
          ... on Order {
            state
          }
          ... on ErrorResult {
            errorCode
            message
          }
        }
      }
    `);
    if (addPaymentToOrder.errorCode) throw new Error(addPaymentToOrder.message);
  }
  return order as { id: string; code: string };
}

/** Polls the order's invoices until `predicate` holds (jobs run asynchronously). */
export async function waitForInvoices(
  adminClient: SimpleGraphQLClient,
  orderId: string,
  predicate: (invoices: InvoiceResult[]) => boolean,
  timeoutMs = 10_000,
): Promise<InvoiceResult[]> {
  const start = Date.now();
  for (;;) {
    const { order } = await adminClient.query(ORDER_INVOICES, { id: orderId });
    if (predicate(order.eInvoices)) return order.eInvoices;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for invoices of order ${orderId}: ${JSON.stringify(order.eInvoices)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Reads the stored files of an invoice directly from the database (download API follows in a later milestone). */
export async function readFiles(server: TestServer, invoiceNumber: string): Promise<Record<string, string>> {
  const connection = server.app.get(TransactionalConnection).rawConnection;
  const invoice = await connection.getRepository(EInvoice).findOneOrFail({ where: { number: invoiceNumber }, relations: ['files'] });
  const out: Record<string, string> = {};
  for (const file of invoice.files) {
    const blob = await connection.getRepository(EInvoiceBlob).findOneOrFail({ where: { id: file.storageId } });
    out[file.format] = Buffer.from(blob.data).toString('utf8');
  }
  return out;
}

/** Writes generated files to `test/__output__/e2e/` so they can be checked with `pnpm validate test/__output__/e2e`. */
export function writeOutput(name: string, content: string) {
  const dir = path.join(__dirname, '../__output__/e2e');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}
