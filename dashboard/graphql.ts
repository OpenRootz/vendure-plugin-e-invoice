import { graphql, TypedDocumentNode } from '@vendure/dashboard';

/**
 * The plugin's own types are not part of the dashboard's built-in schema types, so documents are created
 * untyped and the result types below are declared by hand. (Projects that generate their own `@/gql`
 * types get the same documents at runtime.)
 */
const doc = <R, V = Record<string, unknown>>(source: string) =>
  (graphql as unknown as (source: string) => TypedDocumentNode<R, V>)(source);

export type EInvoiceStatus = 'BLOCKED' | 'PENDING' | 'ISSUED' | 'FAILED' | 'VOID';
export type EInvoiceType = 'INVOICE' | 'CREDIT_NOTE';
export type EInvoiceFormat = 'ZUGFERD' | 'XRECHNUNG_CII' | 'XRECHNUNG_UBL';

export interface EInvoiceIssue {
  code: string;
  message: string;
  path?: string | null;
}

export interface EInvoiceFile {
  format: EInvoiceFormat;
  fileName: string;
  size: number;
  downloadUrl: string;
}

export interface EInvoiceRow {
  id: string;
  createdAt: string;
  type: EInvoiceType;
  status: EInvoiceStatus;
  reason: string;
  number: string | null;
  issueDate: string | null;
  currencyCode: string;
  totalWithTax: number;
  remainingAmount: number;
  files: EInvoiceFile[];
  issues: EInvoiceIssue[];
  errorMessage: string | null;
  voidReason: string | null;
  correctedInvoice: { id: string; number: string | null } | null;
  validation: { valid: boolean; error: string | null; results: { format: EInvoiceFormat; valid: boolean; messages: { level: string; code: string | null; text: string }[] }[] } | null;
}

export interface EInvoiceCreditable {
  remainingTotal: number;
  chargesGross: number;
  lines: {
    orderLineId: string | null;
    name: string;
    sku: string | null;
    invoicedQuantity: number;
    remainingQuantity: number;
    remainingGross: number;
  }[];
}

const INVOICE_FIELDS = `
  id
  createdAt
  type
  status
  reason
  number
  issueDate
  currencyCode
  totalWithTax
  remainingAmount
  files {
    format
    fileName
    size
    downloadUrl
  }
  issues {
    code
    message
    path
  }
  errorMessage
  voidReason
  correctedInvoice {
    id
    number
  }
  validation {
    valid
    error
    results {
      format
      valid
      messages {
        level
        code
        text
      }
    }
  }
`;

export const orderEInvoicesDocument = doc<{ order: { id: string; code: string; eInvoices: EInvoiceRow[] } | null }, { id: string }>(`
  query EInvoicesOfOrder($id: ID!) {
    order(id: $id) {
      id
      code
      eInvoices {
        ${INVOICE_FIELDS}
      }
    }
  }
`);

export const creditableDocument = doc<{ eInvoice: { id: string; number: string | null; currencyCode: string; creditable: EInvoiceCreditable | null } | null }, { id: string }>(`
  query EInvoiceCreditable($id: ID!) {
    eInvoice(id: $id) {
      id
      number
      currencyCode
      creditable {
        remainingTotal
        chargesGross
        lines {
          orderLineId
          name
          sku
          invoicedQuantity
          remainingQuantity
          remainingGross
        }
      }
    }
  }
`);

export const eInvoiceListDocument = doc<{ eInvoices: { totalItems: number; items: (EInvoiceRow & { orderCode: string; order: { id: string } })[] } }, { options?: unknown }>(`
  query EInvoiceList($options: EInvoiceListOptions) {
    eInvoices(options: $options) {
      totalItems
      items {
        id
        createdAt
        updatedAt
        number
        type
        status
        reason
        issueDate
        orderCode
        order {
          id
        }
        currencyCode
        totalNet
        totalTax
        totalWithTax
        files {
          format
          fileName
          downloadUrl
        }
      }
    }
  }
`);

export const createInvoiceDocument = doc<{ createEInvoice: EInvoiceRow }, { orderId: string }>(`
  mutation CreateEInvoice($orderId: ID!) {
    createEInvoice(orderId: $orderId) {
      id
      status
      number
      issues {
        code
        message
      }
    }
  }
`);

export const retryDocument = doc<{ retryEInvoice: EInvoiceRow | null }, { id: string }>(`
  mutation RetryEInvoice($id: ID!) {
    retryEInvoice(id: $id) {
      id
      status
      number
    }
  }
`);

export const voidDocument = doc<{ voidEInvoice: EInvoiceRow }, { id: string; reason: string }>(`
  mutation VoidEInvoice($id: ID!, $reason: String!) {
    voidEInvoice(id: $id, reason: $reason) {
      id
      status
    }
  }
`);

export const cancelAndReissueDocument = doc<{ cancelAndReissueEInvoice: EInvoiceRow }, { invoiceId: string }>(`
  mutation CancelAndReissueEInvoice($invoiceId: ID!) {
    cancelAndReissueEInvoice(invoiceId: $invoiceId) {
      id
      status
      number
    }
  }
`);

export interface CreditNoteInput {
  invoiceId: string;
  lines?: { orderLineId: string; quantity: number }[];
  shipping?: boolean;
  amount?: number;
  fullReversal?: boolean;
  note?: string;
}

export const createCreditNoteDocument = doc<{ createEInvoiceCreditNote: EInvoiceRow }, { input: CreditNoteInput }>(`
  mutation CreateEInvoiceCreditNote($input: CreateEInvoiceCreditNoteInput!) {
    createEInvoiceCreditNote(input: $input) {
      id
      status
      number
      totalWithTax
    }
  }
`);

export const guestLinkDocument = doc<{ createEInvoiceGuestLink: string }, { invoiceId: string }>(`
  mutation CreateEInvoiceGuestLink($invoiceId: ID!) {
    createEInvoiceGuestLink(invoiceId: $invoiceId)
  }
`);

export const zipLinkDocument = doc<{ createEInvoiceZipLink: string }, { ids: string[] }>(`
  mutation CreateEInvoiceZipLink($ids: [ID!]!) {
    createEInvoiceZipLink(ids: $ids)
  }
`);

export const previewDocument = doc<{ eInvoicePreview: { pdf: string | null; issues: EInvoiceIssue[] } }, { orderId: string }>(`
  query EInvoicePreview($orderId: ID!) {
    eInvoicePreview(orderId: $orderId) {
      pdf
      issues {
        code
        message
        path
      }
    }
  }
`);

export type EInvoiceSample = 'B2B_NET' | 'B2C_GROSS' | 'CREDIT_NOTE' | 'MANY_LINES' | 'WORST_CASE';

export interface LayoutPreview {
  pdf: string | null;
  pageCount: number;
  issues: EInvoiceIssue[];
  blocks: { key: string; page: number; x: number; y: number; w: number; h: number; overflowBy?: number | null }[];
  layoutIssues: { level: 'error' | 'warning'; code: string; message: string; blockKey?: string | null }[];
}

export interface LayoutPreviewInput {
  layout?: unknown;
  seller?: unknown;
  payment?: unknown;
  orderId?: string;
  sample?: EInvoiceSample;
  language?: string;
}

export const layoutPreviewDocument = doc<{ eInvoiceLayoutPreview: LayoutPreview }, { input: LayoutPreviewInput }>(`
  query EInvoiceLayoutPreview($input: EInvoiceLayoutPreviewInput!) {
    eInvoiceLayoutPreview(input: $input) {
      pdf
      pageCount
      issues {
        code
        message
        path
      }
      blocks {
        key
        page
        x
        y
        w
        h
        overflowBy
      }
      layoutIssues {
        level
        code
        message
        blockKey
      }
    }
  }
`);

export type LayoutPresetName = 'DEFAULT' | 'DIN_5008_A' | 'DIN_5008_B' | 'MINIMAL';

export const defaultLayoutDocument = doc<{ eInvoiceDefaultLayout: unknown }, { preset?: LayoutPresetName }>(`
  query EInvoiceDefaultLayout($preset: EInvoiceLayoutPreset) {
    eInvoiceDefaultLayout(preset: $preset)
  }
`);

export const latestOrderDocument = doc<{ orders: { items: { id: string; code: string }[] } }>(`
  query EInvoiceLatestOrder {
    orders(options: { take: 1, sort: { orderPlacedAt: DESC }, filter: { active: { eq: false } } }) {
      items {
        id
        code
      }
    }
  }
`);

export interface SellerSettings {
  name?: string | null;
  tradingName?: string | null;
  vatId?: string | null;
  taxNumber?: string | null;
  legalInfo?: string | null;
  address?: {
    line1?: string | null;
    line2?: string | null;
    postalCode?: string | null;
    city?: string | null;
    countryCode?: string | null;
  } | null;
  contact?: { name?: string | null; phone?: string | null; email?: string | null } | null;
  electronicAddress?: { scheme: string; value: string } | null;
  legalRegistration?: { id: string; scheme?: string | null } | null;
  bank?: { iban: string; bic?: string | null; accountName?: string | null } | null;
}

export interface ChannelSettings {
  enabled: boolean;
  autoIssue: boolean;
  seller: SellerSettings;
  payment: { termsText?: string | null; termDays?: number | null };
  layout: {
    logoAssetId?: string | null;
    /** The layout document (v2) */
    document?: unknown;
  };
}

const SETTINGS_FIELDS = `
  enabled
  autoIssue
  seller {
    name
    tradingName
    vatId
    taxNumber
    legalInfo
    address {
      line1
      line2
      postalCode
      city
      countryCode
    }
    contact {
      name
      phone
      email
    }
    electronicAddress {
      scheme
      value
    }
    legalRegistration {
      id
      scheme
    }
    bank {
      iban
      bic
      accountName
    }
  }
  payment {
    termsText
    termDays
  }
  layout {
    logoAssetId
    document
  }
`;

export const settingsDocument = doc<{ eInvoiceChannelSettings: ChannelSettings; eInvoiceSetupStatus: EInvoiceIssue[] }>(`
  query EInvoiceSettings {
    eInvoiceChannelSettings {
      ${SETTINGS_FIELDS}
    }
    eInvoiceSetupStatus {
      code
      message
      path
    }
  }
`);

export const updateSettingsDocument = doc<{ updateEInvoiceChannelSettings: ChannelSettings }, { input: unknown }>(`
  mutation UpdateEInvoiceSettings($input: UpdateEInvoiceChannelSettingsInput!) {
    updateEInvoiceChannelSettings(input: $input) {
      ${SETTINGS_FIELDS}
    }
  }
`);

export const assetDocument = doc<{ asset: { id: string; name: string; preview: string } | null }, { id: string }>(`
  query EInvoiceLogoAsset($id: ID!) {
    asset(id: $id) {
      id
      name
      preview
    }
  }
`);
