import { CustomFieldConfig, LanguageCode } from '@vendure/core';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
  interface CustomCustomerFields {
    eInvoiceVatId?: string | null;
    eInvoiceBuyerReference?: string | null;
    eInvoiceLeitwegId?: string | null;
  }
  interface CustomOrderFields {
    eInvoiceVatId?: string | null;
    eInvoiceBuyerReference?: string | null;
    eInvoiceLeitwegId?: string | null;
    eInvoicePurchaseOrder?: string | null;
    eInvoiceNote?: string | null;
  }
  interface CustomTaxRateFields {
    eInvoiceCategoryCode?: string | null;
    eInvoiceExemptionReason?: string | null;
    eInvoiceExemptionReasonCode?: string | null;
  }
  interface CustomPaymentMethodFields {
    eInvoicePaymentMeansCode?: string | null;
  }
}

const ui = { tab: 'E-Invoice' };
const t = (en: string, de: string) => [
  { languageCode: LanguageCode.en, value: en },
  { languageCode: LanguageCode.de, value: de },
];

function buyerFields(publicInShop: boolean): CustomFieldConfig[] {
  const shop = { public: publicInShop, readonly: false, nullable: true, ui };
  return [
    {
      name: 'eInvoiceVatId',
      type: 'string',
      label: t('VAT ID', 'USt-IdNr.'),
      description: t('VAT identification number of the buyer (BT-48)', 'Umsatzsteuer-Identifikationsnummer des Käufers (BT-48)'),
      ...shop,
    },
    {
      name: 'eInvoiceBuyerReference',
      type: 'string',
      label: t('Buyer reference', 'Käuferreferenz'),
      description: t('Reference of the buyer (BT-10), e.g. a cost center', 'Referenz des Käufers (BT-10), z. B. eine Kostenstelle'),
      ...shop,
    },
    {
      name: 'eInvoiceLeitwegId',
      type: 'string',
      label: t('Leitweg-ID', 'Leitweg-ID'),
      description: t(
        'Routing ID of German public authorities. When set, an XRechnung is created.',
        'Leitweg-ID öffentlicher Auftraggeber. Wenn gesetzt, wird eine XRechnung erstellt.',
      ),
      ...shop,
    },
  ];
}

const CATEGORY_CODES = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O', 'L', 'M'];
const PAYMENT_MEANS_CODES = ['1', '10', '30', '31', '42', '48', '49', '54', '55', '57', '58', '59', '68', '97', 'ZZZ'];

export function customFields(options: { exposeBuyerFieldsInShop: boolean }) {
  const shop = { public: options.exposeBuyerFieldsInShop, readonly: false, nullable: true, ui };
  return {
    Customer: buyerFields(options.exposeBuyerFieldsInShop),
    Order: [
      ...buyerFields(options.exposeBuyerFieldsInShop),
      {
        name: 'eInvoicePurchaseOrder',
        type: 'string',
        label: t('Purchase order number', 'Bestellnummer des Käufers'),
        description: t('Purchase order reference of the buyer (BT-13)', 'Bestellreferenz des Käufers (BT-13)'),
        ...shop,
      },
      {
        name: 'eInvoiceNote',
        type: 'text',
        label: t('Invoice note', 'Rechnungshinweis'),
        description: t('Printed on the invoice (BT-22)', 'Wird auf die Rechnung gedruckt (BT-22)'),
        public: false,
        nullable: true,
        ui,
      },
    ] as CustomFieldConfig[],
    TaxRate: [
      {
        name: 'eInvoiceCategoryCode',
        type: 'string',
        label: t('VAT category', 'USt-Kategorie'),
        description: t(
          'S standard, Z zero rated, E exempt, AE reverse charge, K intra-community supply, G export, O not subject to VAT. Empty: S for rates > 0.',
          'S Normal, Z Nullsatz, E steuerbefreit, AE Reverse Charge, K innergemeinschaftliche Lieferung, G Ausfuhr, O nicht steuerbar. Leer: S bei Sätzen > 0.',
        ),
        options: CATEGORY_CODES.map((value) => ({ value })),
        public: false,
        nullable: true,
        ui,
      },
      {
        name: 'eInvoiceExemptionReason',
        type: 'string',
        label: t('Exemption reason', 'Befreiungsgrund'),
        description: t('Required for E, AE, K, G and O (BT-120)', 'Pflicht bei E, AE, K, G und O (BT-120)'),
        public: false,
        nullable: true,
        ui,
      },
      {
        name: 'eInvoiceExemptionReasonCode',
        type: 'string',
        label: t('Exemption reason code (VATEX)', 'Befreiungsgrund-Code (VATEX)'),
        description: t('e.g. VATEX-EU-IC (BT-121)', 'z. B. VATEX-EU-IC (BT-121)'),
        public: false,
        nullable: true,
        ui,
      },
    ] as CustomFieldConfig[],
    PaymentMethod: [
      {
        name: 'eInvoicePaymentMeansCode',
        type: 'string',
        label: t('Payment means code', 'Zahlungsart-Code'),
        description: t(
          'UNTDID 4461, e.g. 48 card, 58 SEPA credit transfer, 59 SEPA direct debit, 68 online payment service',
          'UNTDID 4461, z. B. 48 Karte, 58 SEPA-Überweisung, 59 SEPA-Lastschrift, 68 Online-Zahlungsdienst',
        ),
        options: PAYMENT_MEANS_CODES.map((value) => ({ value })),
        public: false,
        nullable: true,
        ui,
      },
    ] as CustomFieldConfig[],
  };
}
