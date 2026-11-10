import { calculate } from './calculate';
import { AllowanceCharge, Buyer, EInvoiceModel, InvoiceLine, IsoDate, Money, PaymentMeans, Seller, VatCategory } from './model';
import { multiply } from './money';

/**
 * Sample invoices for the layout preview: complete, deterministic models with a fixed fictitious buyer, so a
 * layout can be checked without a placed order. The seller and payment data are the shop's own.
 */
export type SampleKind = 'b2b-net' | 'b2c-gross' | 'credit-note' | 'many-lines' | 'worst-case';

export const SAMPLE_KINDS: SampleKind[] = ['b2b-net', 'b2c-gross', 'credit-note', 'many-lines', 'worst-case'];

export interface SampleOptions {
  seller: Seller;
  bank?: { iban: string; bic?: string; accountName?: string };
  /** BT-20 payment terms text for amounts that are due */
  paymentTerms?: string;
  /** Days from the issue date to the due date */
  paymentTermDays?: number;
  /** Placeholder number, e.g. "ENTWURF" */
  number: string;
  language?: string;
  currencyCode?: string;
  issueDate?: IsoDate;
  amountDecimals?: number;
}

const VAT_19: VatCategory = { code: 'S', rate: '19' };
const VAT_7: VatCategory = { code: 'S', rate: '7' };

type Texts = {
  products: { name: string; description?: string }[];
  shipping: string;
  promotion: string;
  note: string;
  exemption: string;
  creditNote: string;
  longDescription: string;
  card: string;
};

const TEXTS: Record<'de' | 'en', Texts> = {
  de: {
    products: [
      { name: 'Bio-Kaffeebohnen Hochland, 1 kg', description: 'Röstung: mittel' },
      { name: 'Keramiktasse Steingut, 350 ml' },
      { name: 'Fachbuch „Kaffee verstehen“', description: 'Taschenbuch, 2. Auflage' },
      { name: 'Milchaufschäumer elektrisch' },
      { name: 'Entkalker für Siebträgermaschinen, 500 ml' },
      { name: 'Papierfilter Größe 4, 100 Stück' },
    ],
    shipping: 'Versand DHL Paket',
    promotion: 'Aktion: 10 % Herbstrabatt',
    note: 'Lieferung erfolgt in zwei Teilsendungen.',
    exemption: 'Steuerfrei gemäß § 4 Nr. 14 UStG',
    creditNote: 'Teilrückgabe',
    card: 'Kreditkarte',
    longDescription: 'Ausführliche Artikelbeschreibung mit Variante, Farbe, Größe und Seriennummer, damit auch lange Zeilen umbrechen',
  },
  en: {
    products: [
      { name: 'Organic highland coffee beans, 1 kg', description: 'Roast: medium' },
      { name: 'Stoneware mug, 350 ml' },
      { name: 'Book “Understanding Coffee”', description: 'Paperback, 2nd edition' },
      { name: 'Electric milk frother' },
      { name: 'Descaler for espresso machines, 500 ml' },
      { name: 'Paper filters size 4, 100 pieces' },
    ],
    shipping: 'Shipping DHL parcel',
    promotion: 'Promotion: 10 % autumn discount',
    note: 'Delivery in two partial shipments.',
    exemption: 'Exempt from VAT',
    creditNote: 'Partial return',
    card: 'Credit card',
    longDescription: 'Detailed item description with variant, colour, size and serial number, so that long lines wrap',
  },
};

/**
 * Builds a complete sample model with calculated totals. Every kind passes `checkModel()` when the seller data
 * is complete (including payment terms for the kinds with an amount due).
 */
export function sampleModel(kind: SampleKind, options: SampleOptions): EInvoiceModel {
  const language = options.language ?? 'de';
  const t = TEXTS[language.toLowerCase().startsWith('de') ? 'de' : 'en'];
  const issueDate = options.issueDate ?? '2026-11-10';
  const decimals = options.amountDecimals ?? 2;
  const unit = 10 ** decimals;
  const price = (major: number): Money => Math.round(major * unit);
  const gross = kind === 'b2c-gross';
  const business = !gross;

  let lineNo = 0;
  const line = (
    p: { name: string; description?: string },
    net: number,
    qty: string,
    vat: VatCategory,
    extra: Partial<InvoiceLine> = {},
  ): InvoiceLine => {
    lineNo++;
    const netUnitPrice = price(net);
    const allowances = extra.allowances ?? [];
    return {
      id: String(lineNo),
      name: p.name,
      description: p.description,
      sellerItemId: `ART-${String(1000 + lineNo)}`,
      quantity: qty,
      unitCode: 'H87',
      netUnitPrice,
      allowances,
      charges: [],
      netAmount: multiply(netUnitPrice, qty) - allowances.reduce((s, a) => s + a.amount, 0),
      vat,
      ...extra,
    };
  };

  const buyer: Buyer = business
    ? {
        name: 'Musterkunde GmbH',
        isBusiness: true,
        address: { line1: 'Kundenweg 7', postalCode: '80331', city: 'München', countryCode: 'DE' },
        vatId: 'DE987654321',
        contact: { name: 'Erika Mustermann' },
        electronicAddress: { scheme: 'EM', value: 'einkauf@example.org' },
      }
    : {
        name: 'Max Mustermann',
        isBusiness: false,
        address: { line1: 'Hauptstraße 12', postalCode: '50667', city: 'Köln', countryCode: 'DE' },
        electronicAddress: { scheme: 'EM', value: 'max@example.org' },
      };

  let lines: InvoiceLine[];
  const charges: AllowanceCharge[] = [];
  const notes: string[] = [];
  let delivery: EInvoiceModel['delivery'];
  let orderReference: string | undefined;
  let buyerReference = 'SAMPLE-1001';
  const exemptCategory: VatCategory = { code: 'E', rate: '0', exemptionReason: t.exemption };

  switch (kind) {
    case 'b2b-net':
    case 'credit-note':
      lines = [
        line(t.products[0], 18.9, '2', VAT_7),
        line(t.products[1], 9.9, '4', VAT_19, {
          allowances: [{ amount: price(3.96), reason: t.promotion }],
        }),
        line(t.products[2], 22.43, '1', VAT_7),
        line(t.products[3], 41.18, '1', VAT_19),
      ];
      if (kind === 'b2b-net') {
        charges.push({ amount: price(4.95), reason: t.shipping, reasonCode: 'FC', vat: VAT_19 });
        delivery = {
          name: 'Musterkunde GmbH, Lager',
          address: { line1: 'Industriestraße 40', postalCode: '85748', city: 'Garching', countryCode: 'DE' },
        };
      } else {
        lines = [lines[1], lines[3]].map((l, i) => ({ ...l, id: String(i + 1), quantity: '1', allowances: [], netAmount: l.netUnitPrice }));
        notes.push(t.creditNote);
      }
      break;
    case 'b2c-gross':
      lines = [line(t.products[0], 17.66, '1', VAT_7), line(t.products[1], 8.4, '2', VAT_19), line(t.products[4], 7.56, '1', VAT_19)];
      charges.push({ amount: price(4.15), reason: t.shipping, reasonCode: 'FC', vat: VAT_19 });
      break;
    case 'many-lines':
      lines = Array.from({ length: 40 }, (_, i) => {
        const p = t.products[i % t.products.length];
        return line(p, 3.5 + ((i * 7) % 40), String(1 + (i % 3)), i % 2 ? VAT_7 : VAT_19);
      });
      charges.push({ amount: price(4.95), reason: t.shipping, reasonCode: 'FC', vat: VAT_19 });
      break;
    case 'worst-case':
      lines = [
        ...t.products.map((p, i) =>
          line(
            { name: `${p.name} – ${t.longDescription.slice(0, 40)}`, description: t.longDescription },
            12.34 + i * 11.11,
            String(1 + i),
            [VAT_19, VAT_7][i % 2],
            {
              allowances: i % 2 ? [{ amount: price(1), reason: t.promotion }] : [],
            },
          ),
        ),
        line({ name: `${t.products[2].name} (${t.exemption})`, description: t.longDescription }, 48, '1', exemptCategory),
      ];
      charges.push({ amount: price(4.95), reason: t.shipping, reasonCode: 'FC', vat: VAT_19 });
      notes.push(t.note, t.longDescription);
      orderReference = 'PO-2026-000123456789';
      buyerReference = 'LEITWEG-991-12345-67';
      buyer.name = 'Musterkunde Handels- und Vertriebsgesellschaft mbH & Co. KG';
      buyer.contact = { name: 'Dr. Erika Mustermann-Beispielfrau' };
      buyer.address = {
        line1: 'Abteilung Rechnungseingang und Kreditorenbuchhaltung',
        line2: 'Gebäude C, 3. Obergeschoss, Raum 3.14',
        line3: 'Postfach 12 34 56',
        postalCode: '1010',
        city: 'Wien',
        countryCode: 'AT',
      };
      buyer.vatId = 'ATU12345678';
      delivery = {
        name: 'Musterkunde Handels- und Vertriebsgesellschaft mbH & Co. KG, Zentrallager Nord',
        address: {
          line1: 'Industriestraße 40, Halle 7, Tor 12',
          line2: 'Anlieferung Rampe 3',
          postalCode: '1220',
          city: 'Wien',
          countryCode: 'AT',
        },
      };
      break;
  }

  const seller = options.seller;
  const model: EInvoiceModel = {
    schemaVersion: 1,
    type: kind === 'credit-note' ? 'credit_note' : 'invoice',
    number: options.number,
    issueDate,
    currencyCode: options.currencyCode ?? 'EUR',
    amountDecimals: decimals,
    language,
    buyerReference,
    orderReference,
    salesOrderReference: 'SAMPLE-1001',
    precedingInvoices: kind === 'credit-note' ? [{ number: 'RE-2026-00042', issueDate }] : [],
    deliveryDate: issueDate,
    notes,
    seller,
    buyer,
    delivery,
    lines,
    allowances: [],
    charges,
    payment: { means: [], prepaidAmount: 0 },
    taxCalculation: 'en16931',
    meta: {
      orderId: 'sample',
      orderCode: 'SAMPLE-1001',
      channelCode: 'sample',
      pricesIncludeTax: gross,
      priceDisplay: gross ? 'gross' : 'net',
      settlement: kind === 'credit-note' ? 'refund' : undefined,
    },
  };

  const total = calculate(model).grandTotal;
  // b2c: paid in advance; credit notes: the credited amount counts as paid; worst case: partly paid
  const prepaid = kind === 'b2c-gross' || kind === 'credit-note' ? total : kind === 'worst-case' ? price(50) : 0;
  model.payment.prepaidAmount = prepaid;
  const means: PaymentMeans[] = [];
  if (kind === 'b2c-gross') means.push({ code: '54', text: t.card, cardNetwork: 'VISA', cardLast4: '4242' });
  if (prepaid < total) {
    if (options.bank?.iban) means.push({ code: '58', ...options.bank });
    model.payment.terms = options.paymentTerms;
    if (options.paymentTermDays !== undefined) model.payment.dueDate = addDays(issueDate, options.paymentTermDays);
    model.payment.reference = options.number;
  }
  model.payment.means = means;
  model.totals = calculate(model);
  return model;
}

function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
