/**
 * Neutral invoice model, based on the semantic data model of EN 16931.
 * Comments reference the business terms (BT-*) and groups (BG-*) of the standard.
 *
 * Conventions:
 * - `Money` is an integer amount in minor units (see {@link EInvoiceModel.amountDecimals}).
 * - Rates and quantities are decimal strings, so no floating-point value is ever used in calculations.
 * - Credit notes (type code 381) carry positive amounts, as EN 16931 requires.
 */

/** Integer amount in minor units, e.g. `1999` = 19.99 with two decimals. */
export type Money = number;
/** Decimal number as a string, e.g. `"19"`, `"5.5"`, `"2"`. */
export type Decimal = string;
/** Calendar date `YYYY-MM-DD`. */
export type IsoDate = string;

/** UNTDID 5305 VAT category codes allowed by EN 16931. */
export type VatCategoryCode = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O' | 'L' | 'M';

export type EInvoiceFormat = 'zugferd' | 'xrechnung-cii' | 'xrechnung-ubl';

export type EInvoiceType = 'invoice' | 'credit_note';

export interface VatCategory {
  /** BT-151 (line) / BT-95, BT-102 (allowance/charge) / BT-118 (breakdown) */
  code: VatCategoryCode;
  /** BT-152 / BT-96, BT-103 / BT-119 */
  rate: Decimal;
  /** BT-120 */
  exemptionReason?: string;
  /** BT-121, e.g. `VATEX-EU-IC` */
  exemptionReasonCode?: string;
}

export interface Address {
  line1: string;
  line2?: string;
  line3?: string;
  postalCode: string;
  city: string;
  /** ISO 3166-1 alpha-2 */
  countryCode: string;
  subdivision?: string;
}

/** BT-34 / BT-49 with scheme (BT-34-1 / BT-49-1), e.g. `EM` for email, `0204` for a Leitweg-ID. */
export interface ElectronicAddress {
  scheme: string;
  value: string;
}

export interface Contact {
  name?: string;
  phone?: string;
  email?: string;
}

export interface Party {
  /** BT-27 / BT-44 */
  name: string;
  /** BT-28 / BT-45 */
  tradingName?: string;
  address: Address;
  /** BT-31 / BT-48 */
  vatId?: string;
  electronicAddress?: ElectronicAddress;
}

export interface Seller extends Party {
  /** BT-32 (German Steuernummer) */
  taxNumber?: string;
  /** BT-30 with scheme BT-30-1 (e.g. commercial register number) */
  legalRegistration?: { id: string; scheme?: string };
  /** BT-33 additional legal information */
  legalInfo?: string;
  /** BG-6 (mandatory in XRechnung) */
  contact: Contact;
}

export interface Buyer extends Party {
  /** Business customer (company or VAT ID present). Drives the PDF price display. */
  isBusiness: boolean;
  /** BG-9 */
  contact?: Contact;
}

/** Allowance (BG-20 / BG-27) or charge (BG-21 / BG-28). Amounts are always positive. */
export interface AllowanceCharge {
  amount: Money;
  /** BT-97 / BT-104 / BT-139 / BT-144 */
  reason: string;
  /** UNTDID 5189 (allowances) or 7161 (charges), e.g. `FC` for freight */
  reasonCode?: string;
  /** VAT category; required on document level, ignored on line level */
  vat?: VatCategory;
  /** Tax as computed by Vendure for this amount (used by `taxCalculation: 'vendure'`) */
  vendureTaxAmount?: Money;
  /** Technical rounding adjustment (gross-price channels); not serialized, hidden in gross price display */
  rounding?: boolean;
  /** Credit notes: the item of the corrected invoice this credits (not serialized) */
  creditOf?: CreditReference;
}

/**
 * Credit notes: which item of the corrected invoice a credit note item reverses.
 * Items without a reference are amount credits (e.g. goodwill refunds), split by VAT rate.
 */
export type CreditReference = { line: string } | { charge: number } | { allowance: number };

export interface InvoiceLine {
  /** BT-126 */
  id: string;
  /** Vendure order line, for traceability only (not serialized) */
  orderLineId?: string;
  /** BT-153 */
  name: string;
  /** BT-154 */
  description?: string;
  /** BT-155 */
  sellerItemId?: string;
  /** BT-157 */
  gtin?: string;
  /** BT-129 */
  quantity: Decimal;
  /** BT-130, UN/ECE Recommendation 20 (default `H87` = piece) */
  unitCode: string;
  /** BT-146 */
  netUnitPrice: Money;
  /** BG-27 */
  allowances: AllowanceCharge[];
  /** BG-28 */
  charges: AllowanceCharge[];
  /** BT-131 = quantity × net price − allowances + charges (exact) */
  netAmount: Money;
  vat: VatCategory;
  /** Tax as computed by Vendure for this line */
  vendureTaxAmount?: Money;
  /** For the PDF only; never written to the XML */
  display?: { grossUnitPrice?: Money; grossAmount?: Money };
  /** Credit notes: the item of the corrected invoice this line credits (not serialized) */
  creditOf?: CreditReference;
}

export type PaymentMeans =
  | { code: '58'; iban: string; bic?: string; accountName?: string; text?: string }
  | { code: '59'; mandateReference: string; creditorId: string; debtorIban: string; text?: string }
  | { code: '48' | '54' | '55'; cardLast4?: string; cardNetwork?: string; text?: string }
  | { code: string; text?: string };

export interface VatBreakdown {
  category: VatCategory;
  /** BT-116 */
  basisAmount: Money;
  /** BT-117 */
  taxAmount: Money;
}

export interface Totals {
  /** BT-106 sum of line net amounts */
  lineTotal: Money;
  /** BT-107 sum of document-level allowances */
  allowanceTotal: Money;
  /** BT-108 sum of document-level charges */
  chargeTotal: Money;
  /** BT-109 */
  taxBasisTotal: Money;
  /** BT-110 */
  taxTotal: Money;
  /** BT-112 */
  grandTotal: Money;
  /** BT-113 */
  prepaidAmount: Money;
  /** BT-114 (0 unless `taxCalculation` is `'en16931'`) */
  roundingAmount: Money;
  /** BT-115 */
  duePayable: Money;
  /** BG-23 */
  vat: VatBreakdown[];
  /** The tax calculation that was actually applied (after a possible fallback) */
  taxCalculation: TaxCalculation;
  /** `expectedTotalWithTax − (grandTotal + roundingAmount)`; 0 when it matches or nothing was expected */
  expectedTotalDifference: Money;
  warnings: string[];
}

export type TaxCalculation = 'vendure' | 'en16931';

export interface EInvoiceModel {
  /** Version of this structure, for migrating stored snapshots */
  schemaVersion: 1;
  /** BT-3: `invoice` → 380, `credit_note` → 381 */
  type: EInvoiceType;
  /** BT-1 */
  number: string;
  /** BT-2 */
  issueDate: IsoDate;
  /** BT-5 */
  currencyCode: string;
  /** Number of decimals of `Money` values (Vendure `MoneyStrategy.precision`, usually 2) */
  amountDecimals: number;
  /** Language of the human-readable parts (PDF labels, product names) */
  language: string;
  /** BT-10 */
  buyerReference: string;
  /** BT-13 purchase order reference of the buyer (e.g. their PO number) */
  orderReference?: string;
  /** BT-14 sales order reference of the seller (the Vendure order code) */
  salesOrderReference?: string;
  /** BG-3 (credit notes: the corrected invoice) */
  precedingInvoices: { number: string; issueDate: IsoDate }[];
  /** BT-72 */
  deliveryDate?: IsoDate;
  /** BT-22 */
  notes: string[];
  seller: Seller;
  buyer: Buyer;
  /** BG-13 / BG-15 deliver-to party (only if different from the buyer address) */
  delivery?: { name?: string; address: Address };
  lines: InvoiceLine[];
  /** BG-20 */
  allowances: AllowanceCharge[];
  /** BG-21 (shipping = `FC`, surcharges) */
  charges: AllowanceCharge[];
  payment: {
    /** BG-16 */
    means: PaymentMeans[];
    /** BT-20 */
    terms?: string;
    /** BT-9 */
    dueDate?: IsoDate;
    /** BT-113 */
    prepaidAmount: Money;
    /** BT-83 remittance information (e.g. the invoice number) */
    reference?: string;
  };
  /** Requested tax calculation; see {@link Totals.taxCalculation} for the applied one */
  taxCalculation: TaxCalculation;
  /** Filled by `calculate()` and stored with the snapshot, so XML and PDF never recompute differently */
  totals?: Totals;
  meta: {
    orderId: string;
    orderCode: string;
    channelCode: string;
    pricesIncludeTax: boolean;
    priceDisplay: 'gross' | 'net';
    /** Credit notes: refunded to the buyer (default) or offset against a new invoice (cancel and reissue) */
    settlement?: 'refund' | 'offset';
  };
}
