import { Address, AllowanceCharge, Contact, EInvoiceModel, InvoiceLine, Money, Party, PaymentMeans, Seller, VatCategory } from '../model';
import { formatAmount, normalizeDecimal } from '../money';
import { el, optEl, serialize, textEl, XmlElement } from './builder';
import { documentTypeCode, PEPPOL_PROFILE, XRECHNUNG_CUSTOMIZATION } from './constants';

const NS = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  creditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
};

/**
 * OASIS UBL 2.1 Invoice / CreditNote in the XRechnung 3.0 profile.
 * Element order follows the UBL XSD sequences.
 */
export function toUbl(model: EInvoiceModel): string {
  const totals = model.totals;
  if (!totals) throw new Error(`Invoice ${model.number}: totals have not been calculated`);
  const isCredit = model.type === 'credit_note';
  const currencyID = model.currencyCode;
  const amount = (name: string, v: Money) => el(name, { currencyID }, formatAmount(v, model.amountDecimals));
  const debit = model.payment.means.find((p): p is Extract<PaymentMeans, { code: '59' }> => p.code === '59');

  const root = el(
    isCredit ? 'CreditNote' : 'Invoice',
    { xmlns: isCredit ? NS.creditNote : NS.invoice, 'xmlns:cac': NS.cac, 'xmlns:cbc': NS.cbc },
    el('cbc:CustomizationID', {}, XRECHNUNG_CUSTOMIZATION),
    el('cbc:ProfileID', {}, PEPPOL_PROFILE),
    el('cbc:ID', {}, model.number),
    el('cbc:IssueDate', {}, model.issueDate),
    !isCredit && textEl('cbc:DueDate', model.payment.dueDate),
    el(isCredit ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode', {}, documentTypeCode(model.type)),
    model.notes.map((n) => el('cbc:Note', {}, n)),
    el('cbc:DocumentCurrencyCode', {}, model.currencyCode),
    textEl('cbc:BuyerReference', model.buyerReference),
    (model.orderReference || model.salesOrderReference) &&
      el(
        'cac:OrderReference',
        {},
        // cbc:ID (BT-13) is mandatory in UBL; "NA" is the Peppol convention when only BT-14 is known
        el('cbc:ID', {}, model.orderReference || 'NA'),
        textEl('cbc:SalesOrderID', model.salesOrderReference),
      ),
    model.precedingInvoices.map((p) =>
      el(
        'cac:BillingReference',
        {},
        el('cac:InvoiceDocumentReference', {}, el('cbc:ID', {}, p.number), el('cbc:IssueDate', {}, p.issueDate)),
      ),
    ),
    el('cac:AccountingSupplierParty', {}, party(model.seller, model.seller.contact, model.seller, debit?.creditorId)),
    el('cac:AccountingCustomerParty', {}, party(model.buyer, model.buyer.contact)),
    (model.deliveryDate || model.delivery) &&
      el(
        'cac:Delivery',
        {},
        textEl('cbc:ActualDeliveryDate', model.deliveryDate),
        model.delivery && el('cac:DeliveryLocation', {}, address('cac:Address', model.delivery.address)),
        model.delivery?.name && el('cac:DeliveryParty', {}, el('cac:PartyName', {}, el('cbc:Name', {}, model.delivery.name))),
      ),
    model.payment.means.map((means) => paymentMeans(means, model.payment.reference)),
    model.payment.terms && el('cac:PaymentTerms', {}, el('cbc:Note', {}, model.payment.terms)),
    model.allowances.map((a) => allowanceCharge(a, false, amount, true)),
    model.charges.map((c) => allowanceCharge(c, true, amount, true)),
    el(
      'cac:TaxTotal',
      {},
      amount('cbc:TaxAmount', totals.taxTotal),
      totals.vat.map((v) =>
        el(
          'cac:TaxSubtotal',
          {},
          amount('cbc:TaxableAmount', v.basisAmount),
          amount('cbc:TaxAmount', v.taxAmount),
          taxCategory('cac:TaxCategory', v.category, true),
        ),
      ),
    ),
    el(
      'cac:LegalMonetaryTotal',
      {},
      amount('cbc:LineExtensionAmount', totals.lineTotal),
      amount('cbc:TaxExclusiveAmount', totals.taxBasisTotal),
      amount('cbc:TaxInclusiveAmount', totals.grandTotal),
      model.allowances.length > 0 && amount('cbc:AllowanceTotalAmount', totals.allowanceTotal),
      model.charges.length > 0 && amount('cbc:ChargeTotalAmount', totals.chargeTotal),
      totals.prepaidAmount !== 0 && amount('cbc:PrepaidAmount', totals.prepaidAmount),
      totals.roundingAmount !== 0 && amount('cbc:PayableRoundingAmount', totals.roundingAmount),
      amount('cbc:PayableAmount', totals.duePayable),
    ),
    model.lines.map((line) => invoiceLine(line, isCredit, amount)),
  );
  return serialize(root);
}

type AmountFn = (name: string, v: Money) => XmlElement;

function taxCategory(name: string, category: VatCategory, withExemption: boolean): XmlElement {
  return el(
    name,
    {},
    el('cbc:ID', {}, category.code),
    category.code !== 'O' && el('cbc:Percent', {}, normalizeDecimal(category.rate)),
    withExemption && textEl('cbc:TaxExemptionReasonCode', category.exemptionReasonCode),
    withExemption && textEl('cbc:TaxExemptionReason', category.exemptionReason),
    el('cac:TaxScheme', {}, el('cbc:ID', {}, 'VAT')),
  );
}

function allowanceCharge(ac: AllowanceCharge, isCharge: boolean, amount: AmountFn, documentLevel: boolean): XmlElement {
  return el(
    'cac:AllowanceCharge',
    {},
    el('cbc:ChargeIndicator', {}, String(isCharge)),
    textEl('cbc:AllowanceChargeReasonCode', ac.reasonCode),
    textEl('cbc:AllowanceChargeReason', ac.reason),
    amount('cbc:Amount', ac.amount),
    documentLevel && taxCategory('cac:TaxCategory', ac.vat as VatCategory, false),
  );
}

/** Trade party (BG-4 / BG-7). Seller-only fields are written when `seller` is given. */
function party(p: Party, contact: Contact | undefined, seller?: Seller, sepaCreditorId?: string): XmlElement {
  return el(
    'cac:Party',
    {},
    p.electronicAddress && el('cbc:EndpointID', { schemeID: p.electronicAddress.scheme }, p.electronicAddress.value),
    sepaCreditorId && el('cac:PartyIdentification', {}, el('cbc:ID', { schemeID: 'SEPA' }, sepaCreditorId)),
    p.tradingName && el('cac:PartyName', {}, el('cbc:Name', {}, p.tradingName)),
    address('cac:PostalAddress', p.address),
    p.vatId && el('cac:PartyTaxScheme', {}, el('cbc:CompanyID', {}, p.vatId), el('cac:TaxScheme', {}, el('cbc:ID', {}, 'VAT'))),
    seller?.taxNumber &&
      el('cac:PartyTaxScheme', {}, el('cbc:CompanyID', {}, seller.taxNumber), el('cac:TaxScheme', {}, el('cbc:ID', {}, 'FC'))),
    el(
      'cac:PartyLegalEntity',
      {},
      el('cbc:RegistrationName', {}, p.name),
      seller?.legalRegistration && el('cbc:CompanyID', { schemeID: seller.legalRegistration.scheme }, seller.legalRegistration.id),
      textEl('cbc:CompanyLegalForm', seller?.legalInfo),
    ),
    contact &&
      optEl(
        'cac:Contact',
        {},
        textEl('cbc:Name', contact.name),
        textEl('cbc:Telephone', contact.phone),
        textEl('cbc:ElectronicMail', contact.email),
      ),
  );
}

function address(name: string, a: Address): XmlElement {
  return el(
    name,
    {},
    textEl('cbc:StreetName', a.line1),
    textEl('cbc:AdditionalStreetName', a.line2),
    textEl('cbc:CityName', a.city),
    textEl('cbc:PostalZone', a.postalCode),
    textEl('cbc:CountrySubentity', a.subdivision),
    a.line3 && el('cac:AddressLine', {}, el('cbc:Line', {}, a.line3)),
    el('cac:Country', {}, el('cbc:IdentificationCode', {}, a.countryCode)),
  );
}

function paymentMeans(means: PaymentMeans, reference: string | undefined): XmlElement {
  return el(
    'cac:PaymentMeans',
    {},
    el('cbc:PaymentMeansCode', { name: means.text }, means.code),
    textEl('cbc:PaymentID', reference),
    'cardLast4' in means &&
      means.cardLast4 &&
      el(
        'cac:CardAccount',
        {},
        el('cbc:PrimaryAccountNumberID', {}, means.cardLast4),
        // NetworkID is mandatory in UBL
        el('cbc:NetworkID', {}, means.cardNetwork || 'NA'),
      ),
    'iban' in means &&
      el(
        'cac:PayeeFinancialAccount',
        {},
        el('cbc:ID', {}, means.iban),
        textEl('cbc:Name', means.accountName),
        means.bic && el('cac:FinancialInstitutionBranch', {}, el('cbc:ID', {}, means.bic)),
      ),
    'mandateReference' in means &&
      el(
        'cac:PaymentMandate',
        {},
        el('cbc:ID', {}, means.mandateReference),
        el('cac:PayerFinancialAccount', {}, el('cbc:ID', {}, means.debtorIban)),
      ),
  );
}

function invoiceLine(line: InvoiceLine, isCredit: boolean, amount: AmountFn): XmlElement {
  return el(
    isCredit ? 'cac:CreditNoteLine' : 'cac:InvoiceLine',
    {},
    el('cbc:ID', {}, line.id),
    el(isCredit ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity', { unitCode: line.unitCode }, normalizeDecimal(line.quantity)),
    amount('cbc:LineExtensionAmount', line.netAmount),
    line.allowances.map((a) => allowanceCharge(a, false, amount, false)),
    line.charges.map((c) => allowanceCharge(c, true, amount, false)),
    el(
      'cac:Item',
      {},
      textEl('cbc:Description', line.description),
      el('cbc:Name', {}, line.name),
      line.sellerItemId && el('cac:SellersItemIdentification', {}, el('cbc:ID', {}, line.sellerItemId)),
      line.gtin && el('cac:StandardItemIdentification', {}, el('cbc:ID', { schemeID: '0160' }, line.gtin)),
      taxCategory('cac:ClassifiedTaxCategory', line.vat, false),
    ),
    el('cac:Price', {}, amount('cbc:PriceAmount', line.netUnitPrice)),
  );
}
