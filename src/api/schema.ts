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

  type EInvoiceChannelSettings {
    enabled: Boolean!
    autoIssue: Boolean!
    seller: JSON!
    payment: JSON!
    layout: JSON!
  }

  input UpdateEInvoiceChannelSettingsInput {
    enabled: Boolean
    autoIssue: Boolean
    seller: JSON
    payment: JSON
    layout: JSON
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
