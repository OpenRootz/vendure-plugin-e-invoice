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
    "BLOCKED: map the order again. FAILED: render the files again."
    retryEInvoice(id: ID!): EInvoice!
    updateEInvoiceChannelSettings(input: UpdateEInvoiceChannelSettingsInput!): EInvoiceChannelSettings!
  }
`;
