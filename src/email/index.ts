import { LanguageCode } from '@vendure/core';
import { EmailEventListener } from '@vendure/email-plugin';

import { EInvoiceDeliveryRequestedEvent } from '../events';
import { DeliveryEmail, EInvoiceDeliveryService } from '../services/delivery.service';
import { DELIVERY_EMAIL_TYPE } from '../strategies/email-plugin-delivery-strategy';

/** Sample data for the EmailPlugin's dev mailbox ("Generate test email"). */
const MOCK_DELIVERY_ID = '__mock__';

const mockEmail: DeliveryEmail = {
  languageCode: 'de',
  subject: 'Rechnung RE-2026-00001 – Demo Shop GmbH',
  attachments: [],
  templateVars: {
    subject: 'Rechnung RE-2026-00001 – Demo Shop GmbH',
    german: true,
    isCreditNote: false,
    documentLabel: 'Rechnung',
    number: 'RE-2026-00001',
    issueDate: '17.11.2026',
    issueDateIso: '2026-11-17',
    totalWithTax: 11900,
    currencyCode: 'EUR',
    orderCode: 'ABC123DEF456',
    buyerName: 'Beispiel Kunde AG',
    sellerName: 'Demo Shop GmbH',
    hasXRechnung: false,
    linkOnly: false,
    files: [{ fileName: 'RE-2026-00001.pdf' }],
  },
};

/**
 * EmailPlugin handler that sends issued invoices and credit notes with their files attached (the ZUGFeRD PDF, plus
 * the XRechnung XML if the document has one). Used by the default {@link EmailPluginDeliveryStrategy}; sending is
 * enabled per channel in the e-invoice settings.
 *
 * The template is `e-invoice-delivery/body.hbs`: copy `templates/e-invoice-delivery` of this package into the
 * EmailPlugin's template directory. The sender is the global template variable `fromAddress`, like for Vendure's
 * default handlers.
 *
 * @example
 * ```ts
 * import { defaultEmailHandlers, EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
 * import { eInvoiceDeliveryHandler } from '@openrootz/vendure-plugin-e-invoice/email';
 *
 * EmailPlugin.init({
 *   handlers: [...defaultEmailHandlers, eInvoiceDeliveryHandler],
 *   templateLoader: new FileBasedTemplateLoader(path.join(__dirname, '../static/email/templates')),
 *   globalTemplateVars: { fromAddress: '"Demo Shop" <noreply@example.com>' },
 *   // ...
 * });
 * ```
 *
 * @category Delivery
 */
export const eInvoiceDeliveryHandler = new EmailEventListener(DELIVERY_EMAIL_TYPE)
  .on(EInvoiceDeliveryRequestedEvent)
  .loadData(({ event, injector }) =>
    String(event.delivery.id) === MOCK_DELIVERY_ID
      ? Promise.resolve(mockEmail)
      : injector.get(EInvoiceDeliveryService).prepareEmail(event.ctx, event.delivery.id),
  )
  .setRecipient((event) => event.delivery.recipient)
  .setFrom('{{ fromAddress }}')
  .setSubject('{{ subject }}')
  .setLanguageCode((event) => toLanguageCode(event.data.languageCode))
  .setTemplateVars((event) => ({ ...event.data.templateVars }))
  .setAttachments((event) => event.data.attachments)
  .setOptionalAddressFields((event) => (event.delivery.bcc ? { bcc: event.delivery.bcc } : {}))
  .setMetadata((event) => ({ eInvoiceDeliveryId: event.delivery.id }))
  .setMockEvent({
    delivery: { id: MOCK_DELIVERY_ID, recipient: 'kunde@example.com', bcc: null },
    invoice: { id: MOCK_DELIVERY_ID, number: 'RE-2026-00001' },
  } as unknown as Omit<EInvoiceDeliveryRequestedEvent, 'ctx'>);

/** `de-DE` → `de`; Vendure's `LanguageCode` has no region variants for most languages. */
function toLanguageCode(language: string): LanguageCode | undefined {
  const codes = Object.values(LanguageCode) as string[];
  const normalized = language.replace('-', '_');
  const match = codes.find((c) => c === normalized) ?? codes.find((c) => c === normalized.split('_')[0]);
  return match as LanguageCode | undefined;
}

export { EInvoiceDeliveryRequestedEvent };
