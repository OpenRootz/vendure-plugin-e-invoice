import gql from 'graphql-tag';

export const adminApiExtensions = gql`
  enum EInvoiceType {
    INVOICE
    CREDIT_NOTE
  }

  enum EInvoiceStatus {
    BLOCKED
    PENDING
    ISSUED
    FAILED
    VOID
  }

  enum EInvoiceFormat {
    ZUGFERD
    XRECHNUNG_CII
    XRECHNUNG_UBL
  }

  type EInvoiceIssue {
    code: String!
    message: String!
    path: String
  }

  type EInvoiceFile {
    id: ID!
    format: EInvoiceFormat!
    fileName: String!
    mimeType: String!
    size: Int!
    sha256: String!
  }

  type EInvoice implements Node {
    id: ID!
    createdAt: DateTime!
    updatedAt: DateTime!
    type: EInvoiceType!
    status: EInvoiceStatus!
    reason: String!
    number: String
    issueDate: String
    currencyCode: CurrencyCode!
    totalNet: Money!
    totalTax: Money!
    totalWithTax: Money!
    formats: [EInvoiceFormat!]!
    files: [EInvoiceFile!]!
    issues: [EInvoiceIssue!]!
    errorMessage: String
    voidReason: String
    "Credit notes: the corrected invoice"
    correctedInvoice: EInvoice
    "Invoices: their credit notes (with a number)"
    creditNotes: [EInvoice!]!
    "Invoices: total minus credit notes; 0 for credit notes"
    remainingAmount: Money!
  }

  input EInvoiceCreditNoteLineInput {
    orderLineId: ID!
    quantity: Int!
  }

  input CreateEInvoiceCreditNoteInput {
    invoiceId: ID!
    "Order lines and quantities to credit, at the invoiced prices"
    lines: [EInvoiceCreditNoteLineInput!]
    "Credit shipping and surcharges"
    shipping: Boolean
    "Gross amount to credit in addition, split across the VAT rates of the invoice. Negative = deduction."
    amount: Money
    "Credit everything that has not been credited yet. The other fields are ignored."
    fullReversal: Boolean
    "Printed on the credit note"
    note: String
  }

  type EInvoiceLayout {
    logoAssetId: ID
    accentColor: String
    introText: String
    closingText: String
    footerText: String
  }

  input EInvoiceLayoutInput {
    "PNG, JPEG or SVG asset shown at the top right of the PDF"
    logoAssetId: ID
    "Hex color, e.g. #1a5fb4"
    accentColor: String
    introText: String
    closingText: String
    footerText: String
  }

  type EInvoiceChannelSettings {
    enabled: Boolean!
    autoIssue: Boolean!
    seller: JSON!
    payment: JSON!
    layout: EInvoiceLayout!
  }

  input UpdateEInvoiceChannelSettingsInput {
    enabled: Boolean
    autoIssue: Boolean
    seller: JSON
    payment: JSON
    layout: EInvoiceLayoutInput
  }

  extend type Order {
    eInvoices: [EInvoice!]!
  }

  extend type Query {
    eInvoice(id: ID!): EInvoice
    eInvoiceChannelSettings: EInvoiceChannelSettings!
  }

  extend type Mutation {
    "Create the invoice for an order. Returns a BLOCKED invoice with issues if data is missing."
    createEInvoice(orderId: ID!): EInvoice!
    """
    BLOCKED invoice: map the order again. BLOCKED credit note: build it from the refund again; returns null if it is
    no longer needed (e.g. the invoice has been credited in full meanwhile) and was removed. FAILED: render the files again.
    """
    retryEInvoice(id: ID!): EInvoice
    "Credit note for an invoice. The credited quantities and amounts can never exceed the invoice."
    createEInvoiceCreditNote(input: CreateEInvoiceCreditNoteInput!): EInvoice!
    "Credit the invoice in full and issue a new one for the current order (e.g. after correcting the buyer data). Returns the new invoice."
    cancelAndReissueEInvoice(invoiceId: ID!): EInvoice!
    updateEInvoiceChannelSettings(input: UpdateEInvoiceChannelSettingsInput!): EInvoiceChannelSettings!
  }
`;
