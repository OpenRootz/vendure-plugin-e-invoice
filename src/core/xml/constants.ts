import { EInvoiceType } from '../model';

/** BT-24 specification identifier for plain EN 16931 (ZUGFeRD / Factur-X profile EN 16931). */
export const EN16931_GUIDELINE = 'urn:cen.eu:en16931:2017';
/** BT-24 for XRechnung 3.0. */
export const XRECHNUNG_CUSTOMIZATION = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';
/** BT-23 business process (Peppol BIS Billing 3.0). */
export const PEPPOL_PROFILE = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

/** BT-3 (UNTDID 1001): 380 commercial invoice, 381 credit note. */
export function documentTypeCode(type: EInvoiceType): '380' | '381' {
  return type === 'credit_note' ? '381' : '380';
}
