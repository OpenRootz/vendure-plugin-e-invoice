import {
  Address,
  AllowanceCharge,
  Contact,
  EInvoiceModel,
  InvoiceLine,
  Money,
  Party,
  PaymentMeans,
  Seller,
  Totals,
  VatCategory,
} from '../model';
import { formatAmount, normalizeDecimal } from '../money';
import { el, optEl, serialize, textEl, XmlElement } from './builder';
import { documentTypeCode, EN16931_GUIDELINE, PEPPOL_PROFILE, XRECHNUNG_CUSTOMIZATION } from './constants';

/**
 * UN/CEFACT Cross Industry Invoice (CII D16B) as used by ZUGFeRD 2.3 / Factur-X 1.07 (profile EN 16931)
 * and XRechnung 3.0 (CII syntax). Element order follows the XSD sequences.
 */
export function toCii(model: EInvoiceModel, flavour: 'zugferd' | 'xrechnung'): string {
  const totals = requireTotals(model);
  const amount = (v: Money) => formatAmount(v, model.amountDecimals);
  const date = (iso: string) => el('udt:DateTimeString', { format: '102' }, iso.replace(/-/g, ''));
  const debit = model.payment.means.find((p): p is Extract<PaymentMeans, { code: '59' }> => p.code === '59');

  const root = el(
    'rsm:CrossIndustryInvoice',
    {
      'xmlns:rsm': 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
      'xmlns:ram': 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
      'xmlns:qdt': 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100',
      'xmlns:udt': 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
    },
    el(
      'rsm:ExchangedDocumentContext',
      {},
      el('ram:BusinessProcessSpecifiedDocumentContextParameter', {}, el('ram:ID', {}, PEPPOL_PROFILE)),
      el(
        'ram:GuidelineSpecifiedDocumentContextParameter',
        {},
        el('ram:ID', {}, flavour === 'xrechnung' ? XRECHNUNG_CUSTOMIZATION : EN16931_GUIDELINE),
      ),
    ),
    el(
      'rsm:ExchangedDocument',
      {},
      el('ram:ID', {}, model.number),
      el('ram:TypeCode', {}, documentTypeCode(model.type)),
      el('ram:IssueDateTime', {}, date(model.issueDate)),
      model.notes.map((note) => el('ram:IncludedNote', {}, el('ram:Content', {}, note))),
    ),
    el(
      'rsm:SupplyChainTradeTransaction',
      {},
      model.lines.map((line) => lineItem(line, amount)),
      el(
        'ram:ApplicableHeaderTradeAgreement',
        {},
        textEl('ram:BuyerReference', model.buyerReference),
        el('ram:SellerTradeParty', {}, party(model.seller, model.seller.contact, model.seller)),
        el('ram:BuyerTradeParty', {}, party(model.buyer, model.buyer.contact)),
        model.salesOrderReference && el('ram:SellerOrderReferencedDocument', {}, el('ram:IssuerAssignedID', {}, model.salesOrderReference)),
        model.orderReference && el('ram:BuyerOrderReferencedDocument', {}, el('ram:IssuerAssignedID', {}, model.orderReference)),
      ),
      el(
        'ram:ApplicableHeaderTradeDelivery',
        {},
        model.delivery && el('ram:ShipToTradeParty', {}, textEl('ram:Name', model.delivery.name), postalAddress(model.delivery.address)),
        model.deliveryDate && el('ram:ActualDeliverySupplyChainEvent', {}, el('ram:OccurrenceDateTime', {}, date(model.deliveryDate))),
      ),
      el(
        'ram:ApplicableHeaderTradeSettlement',
        {},
        debit && el('ram:CreditorReferenceID', {}, debit.creditorId),
        textEl('ram:PaymentReference', model.payment.reference),
        el('ram:InvoiceCurrencyCode', {}, model.currencyCode),
        model.payment.means.map((means) => paymentMeans(means)),
        totals.vat.map((v) =>
          el(
            'ram:ApplicableTradeTax',
            {},
            el('ram:CalculatedAmount', {}, amount(v.taxAmount)),
            el('ram:TypeCode', {}, 'VAT'),
            textEl('ram:ExemptionReason', v.category.exemptionReason),
            el('ram:BasisAmount', {}, amount(v.basisAmount)),
            el('ram:CategoryCode', {}, v.category.code),
            textEl('ram:ExemptionReasonCode', v.category.exemptionReasonCode),
            rate(v.category),
          ),
        ),
        model.allowances.map((a) => headerAllowanceCharge(a, false, amount)),
        model.charges.map((c) => headerAllowanceCharge(c, true, amount)),
        (model.payment.terms || model.payment.dueDate || debit) &&
          el(
            'ram:SpecifiedTradePaymentTerms',
            {},
            textEl('ram:Description', model.payment.terms),
            model.payment.dueDate && el('ram:DueDateDateTime', {}, date(model.payment.dueDate)),
            debit && el('ram:DirectDebitMandateID', {}, debit.mandateReference),
          ),
        monetarySummation(model, totals, amount),
        model.precedingInvoices.map((p) =>
          el(
            'ram:InvoiceReferencedDocument',
            {},
            el('ram:IssuerAssignedID', {}, p.number),
            el('ram:FormattedIssueDateTime', {}, el('qdt:DateTimeString', { format: '102' }, p.issueDate.replace(/-/g, ''))),
          ),
        ),
      ),
    ),
  );
  return serialize(root);
}

function requireTotals(model: EInvoiceModel): Totals {
  if (!model.totals) throw new Error(`Invoice ${model.number}: totals have not been calculated`);
  return model.totals;
}

/** BT-152/119: category O ("not subject to VAT") must not carry a rate. */
function rate(category: VatCategory): XmlElement | undefined {
  return category.code === 'O' ? undefined : el('ram:RateApplicablePercent', {}, normalizeDecimal(category.rate));
}

function lineItem(line: InvoiceLine, amount: (v: Money) => string): XmlElement {
  return el(
    'ram:IncludedSupplyChainTradeLineItem',
    {},
    el('ram:AssociatedDocumentLineDocument', {}, el('ram:LineID', {}, line.id)),
    el(
      'ram:SpecifiedTradeProduct',
      {},
      textEl('ram:GlobalID', line.gtin, { schemeID: '0160' }),
      textEl('ram:SellerAssignedID', line.sellerItemId),
      el('ram:Name', {}, line.name),
      textEl('ram:Description', line.description),
    ),
    el(
      'ram:SpecifiedLineTradeAgreement',
      {},
      el('ram:NetPriceProductTradePrice', {}, el('ram:ChargeAmount', {}, amount(line.netUnitPrice))),
    ),
    el('ram:SpecifiedLineTradeDelivery', {}, el('ram:BilledQuantity', { unitCode: line.unitCode }, normalizeDecimal(line.quantity))),
    el(
      'ram:SpecifiedLineTradeSettlement',
      {},
      el('ram:ApplicableTradeTax', {}, el('ram:TypeCode', {}, 'VAT'), el('ram:CategoryCode', {}, line.vat.code), rate(line.vat)),
      line.allowances.map((a) => lineAllowanceCharge(a, false, amount)),
      line.charges.map((c) => lineAllowanceCharge(c, true, amount)),
      el('ram:SpecifiedTradeSettlementLineMonetarySummation', {}, el('ram:LineTotalAmount', {}, amount(line.netAmount))),
    ),
  );
}

function lineAllowanceCharge(ac: AllowanceCharge, isCharge: boolean, amount: (v: Money) => string): XmlElement {
  return el(
    'ram:SpecifiedTradeAllowanceCharge',
    {},
    el('ram:ChargeIndicator', {}, el('udt:Indicator', {}, String(isCharge))),
    el('ram:ActualAmount', {}, amount(ac.amount)),
    textEl('ram:ReasonCode', ac.reasonCode),
    textEl('ram:Reason', ac.reason),
  );
}

function headerAllowanceCharge(ac: AllowanceCharge, isCharge: boolean, amount: (v: Money) => string): XmlElement {
  const vat = ac.vat as VatCategory; // guaranteed by calculate()
  return el(
    'ram:SpecifiedTradeAllowanceCharge',
    {},
    el('ram:ChargeIndicator', {}, el('udt:Indicator', {}, String(isCharge))),
    el('ram:ActualAmount', {}, amount(ac.amount)),
    textEl('ram:ReasonCode', ac.reasonCode),
    textEl('ram:Reason', ac.reason),
    el('ram:CategoryTradeTax', {}, el('ram:TypeCode', {}, 'VAT'), el('ram:CategoryCode', {}, vat.code), rate(vat)),
  );
}

/** Trade party (BG-4 / BG-7). Seller-only fields are written when `seller` is given. */
function party(p: Party, contact: Contact | undefined, seller?: Seller): XmlElement[] {
  return [
    el('ram:Name', {}, p.name),
    textEl('ram:Description', seller?.legalInfo),
    optEl(
      'ram:SpecifiedLegalOrganization',
      {},
      seller?.legalRegistration && el('ram:ID', { schemeID: seller.legalRegistration.scheme }, seller.legalRegistration.id),
      textEl('ram:TradingBusinessName', p.tradingName),
    ),
    contact &&
      optEl(
        'ram:DefinedTradeContact',
        {},
        textEl('ram:PersonName', contact.name),
        contact.phone && el('ram:TelephoneUniversalCommunication', {}, el('ram:CompleteNumber', {}, contact.phone)),
        contact.email && el('ram:EmailURIUniversalCommunication', {}, el('ram:URIID', {}, contact.email)),
      ),
    postalAddress(p.address),
    p.electronicAddress &&
      el('ram:URIUniversalCommunication', {}, el('ram:URIID', { schemeID: p.electronicAddress.scheme }, p.electronicAddress.value)),
    p.vatId && el('ram:SpecifiedTaxRegistration', {}, el('ram:ID', { schemeID: 'VA' }, p.vatId)),
    seller?.taxNumber && el('ram:SpecifiedTaxRegistration', {}, el('ram:ID', { schemeID: 'FC' }, seller.taxNumber)),
  ].filter((x): x is XmlElement => !!x);
}

function postalAddress(a: Address): XmlElement {
  return el(
    'ram:PostalTradeAddress',
    {},
    textEl('ram:PostcodeCode', a.postalCode),
    textEl('ram:LineOne', a.line1),
    textEl('ram:LineTwo', a.line2),
    textEl('ram:LineThree', a.line3),
    textEl('ram:CityName', a.city),
    el('ram:CountryID', {}, a.countryCode),
    textEl('ram:CountrySubDivisionName', a.subdivision),
  );
}

function paymentMeans(means: PaymentMeans): XmlElement {
  return el(
    'ram:SpecifiedTradeSettlementPaymentMeans',
    {},
    el('ram:TypeCode', {}, means.code),
    textEl('ram:Information', means.text),
    'cardLast4' in means && means.cardLast4 && el('ram:ApplicableTradeSettlementFinancialCard', {}, el('ram:ID', {}, means.cardLast4)),
    'debtorIban' in means && el('ram:PayerPartyDebtorFinancialAccount', {}, el('ram:IBANID', {}, means.debtorIban)),
    'iban' in means &&
      el('ram:PayeePartyCreditorFinancialAccount', {}, el('ram:IBANID', {}, means.iban), textEl('ram:AccountName', means.accountName)),
    'bic' in means && means.bic && el('ram:PayeeSpecifiedCreditorFinancialInstitution', {}, el('ram:BICID', {}, means.bic)),
  );
}

function monetarySummation(model: EInvoiceModel, t: Totals, amount: (v: Money) => string): XmlElement {
  return el(
    'ram:SpecifiedTradeSettlementHeaderMonetarySummation',
    {},
    el('ram:LineTotalAmount', {}, amount(t.lineTotal)),
    model.charges.length > 0 && el('ram:ChargeTotalAmount', {}, amount(t.chargeTotal)),
    model.allowances.length > 0 && el('ram:AllowanceTotalAmount', {}, amount(t.allowanceTotal)),
    el('ram:TaxBasisTotalAmount', {}, amount(t.taxBasisTotal)),
    el('ram:TaxTotalAmount', { currencyID: model.currencyCode }, amount(t.taxTotal)),
    t.roundingAmount !== 0 && el('ram:RoundingAmount', {}, amount(t.roundingAmount)),
    el('ram:GrandTotalAmount', {}, amount(t.grandTotal)),
    t.prepaidAmount !== 0 && el('ram:TotalPrepaidAmount', {}, amount(t.prepaidAmount)),
    el('ram:DuePayableAmount', {}, amount(t.duePayable)),
  );
}
