# @openrootz/vendure-plugin-e-invoice

EN 16931 e-invoicing for [Vendure](https://vendure.io) v3. The plugin issues **ZUGFeRD / Factur-X** invoices
(PDF/A-3b with the CII XML embedded) and **XRechnung** (CII or UBL) for your orders, with gap-free numbering,
credit notes for refunds and cancellations, signed downloads for admins and customers, and a dashboard extension.

In Germany, businesses must be able to receive e-invoices since 2025; issuing them becomes mandatory for B2B from
2027 (turnover above €800k) and for everyone from 2028.

- **One invoice model, several formats**: ZUGFeRD (profile EN 16931) for every order; XRechnung CII when the buyer
  has a Leitweg-ID (German public authorities); UBL on request. Every output is checked with the official validators
  (KoSIT, Mustang, veraPDF) in CI.
- **Gap-free numbers**: the number format is yours (`RE-2026-00001` by default), the counter is row-locked inside
  the issuing transaction. A failed check never uses a number; a failed render keeps it and documents it.
- **Immutable documents**: the invoice data is stored as a snapshot; files are only ever rendered from it.
  Corrections happen through credit notes (type 381).
- **Credit notes**: automatic for settled refunds (amount-only refunds are split across the VAT rates),
  cancellations and order modifications; manual credit notes per line, for shipping or a free amount.
- **No browser, no Java at runtime**: PDFs are rendered with pdfmake (pure JavaScript).

## Contents

- [Installation](#installation)
- [Setup checklist](#setup-checklist)
- [How it works](#how-it-works)
- [Options](#options)
- [Customisation](#customisation)
- [APIs and downloads](#apis-and-downloads)
- [Dashboard](#dashboard)
- [Runtime validation](#runtime-validation)
- [Storage](#storage)
- [Legal notes](#legal-notes)
- [Limitations](#limitations)
- [Development](#development)

## Installation

```bash
pnpm add @openrootz/vendure-plugin-e-invoice
```

Requires Vendure `^3.8` and Node ≥ 22.

```ts
// vendure-config.ts
import { EInvoicePlugin } from '@openrootz/vendure-plugin-e-invoice';

export const config: VendureConfig = {
  // ...
  plugins: [
    EInvoicePlugin.init({
      // Signs download links. At least 32 characters; keep it secret and stable.
      secret: process.env.E_INVOICE_SECRET!,
    }),
  ],
};
```

The plugin adds entities and custom fields, so generate and run a migration
([Vendure migrations](https://docs.vendure.io/guides/developer-guide/migrations/)):

```bash
npx vendure migrate
```

Tables: `e_invoice`, `e_invoice_file`, `e_invoice_sequence`, `e_invoice_channel_settings`, `e_invoice_blob`.

## Setup checklist

E-invoicing is **off** per channel until you enable it.

1. **Seller data** (Settings → E-Invoices in the dashboard, or `updateEInvoiceChannelSettings`): legal name,
   address, VAT ID or tax number, contact (name, phone, email) and an electronic address where buyers send e-invoices
   (e.g. `EM` + `rechnung@example.com`). Add a bank account if invoices can have an amount due.
2. **Tax rates**: every rate of 0 % needs a VAT category in its `E-Invoice` tab (`Z` zero rated, `E` exempt,
   `AE` reverse charge, `K` intra-community supply, `G` export, `O` not subject to VAT). `E`, `AE`, `K`, `G`, `O`
   also need an exemption reason or VATEX code. Rates above 0 % default to `S` (standard).
3. **Payment methods** (optional): the `E-Invoice` tab takes the UNTDID 4461 payment means code, e.g. `48`
   (card), `58` (SEPA credit transfer), `59` (SEPA direct debit), `68` (online payment service). Default: `ZZZ`
   with the method name.
4. **Enable** e-invoicing for the channel. `eInvoiceSetupStatus` (shown on the settings page) lists anything that
   is still missing.
5. Optionally upload a logo and set an accent color and texts for the PDF.

## How it works

```
Order reaches PaymentSettled ─▶ reconcile ─▶ checks ──fail──▶ BLOCKED (no number; fix and retry)
                                               │
                                               └─pass─▶ number reserved, snapshot stored ─▶ PENDING
                                                         render job (worker) ─▶ ISSUED  (or FAILED → retry / void)
```

- **Triggers**: an order entering one of `issueOnStates` (default `PaymentSettled`) gets an invoice, if the
  channel has `autoIssue` on. Admins can always create one manually.
- **Checks** run before a number is reserved and explain problems in plain words (missing seller data, a 0 % rate
  without VAT category, reverse charge without buyer VAT ID, totals that do not match the order, …).
- **Rendering** happens in the job queue from the stored snapshot, never from the (possibly changed) order.
- **Statuses**: `BLOCKED` (checks failed, no number), `PENDING` (rendering), `ISSUED` (final), `FAILED` (rendering
  or validation failed; retry re-renders the snapshot), `VOID` (a failed document that can never be rendered; the
  number stays used and the reason documents the gap).
- **Credit notes** reference the corrected invoice (BT-25) and always use the invoice's snapshot prices:
  - settled refund → credit note for the refunded amount, split proportionally across the VAT rates
    (one credit line per rate);
  - order cancelled → the remaining amount is credited in full;
  - order modified after invoicing → full credit note plus a new invoice for the current order;
  - manual: per line and quantity, shipping, a free amount, or a full reversal.
    The credited quantities and amounts can never exceed the invoice.

### Buyer data

The plugin registers optional custom fields (tab `E-Invoice`):

| Entity          | Fields                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Order`         | `eInvoiceVatId` (BT-48), `eInvoiceBuyerReference` (BT-10), `eInvoiceLeitwegId`, `eInvoicePurchaseOrder` (BT-13), `eInvoiceNote` (BT-22) |
| `Customer`      | `eInvoiceVatId`, `eInvoiceBuyerReference`, `eInvoiceLeitwegId` (used when the order field is empty)                                     |
| `TaxRate`       | `eInvoiceCategoryCode`, `eInvoiceExemptionReason`, `eInvoiceExemptionReasonCode`                                                        |
| `PaymentMethod` | `eInvoicePaymentMeansCode`                                                                                                              |

The order and customer fields are readable and writable in the Shop API by default, so B2B customers can enter
their VAT ID or Leitweg-ID at checkout (`setOrderCustomFields`). Set `exposeBuyerFieldsInShop: false` to keep them
admin-only.

Defaults: name and address from the billing address (company first, fallback shipping address), email as electronic
address, buyer reference = Leitweg-ID, else the buyer reference field, else the order code. With a Leitweg-ID an
XRechnung (CII) is issued in addition to the ZUGFeRD PDF.

## Options

```ts
EInvoicePlugin.init({
  secret: process.env.E_INVOICE_SECRET!, // required
  issueOnStates: ['PaymentSettled'], // automatic invoices
  autoCreditNotes: true, // refunds, cancellations, modifications
  taxCalculation: 'vendure', // or 'en16931', see below
  roundingFallbackThreshold: 50, // minor units
  timeZone: 'Europe/Berlin', // issue and due dates; default: server time zone
  exposeBuyerFieldsInShop: true,
  downloadLinks: { guestTtl: '7d', ownerTtl: '1h', adminTtl: '15m', baseUrl: 'https://shop.example.com' },
  validation: { validator: new KositHttpValidator({ url: 'http://kosit:8080/' }), mode: 'report' },
  storage: new DatabaseInvoiceStorageStrategy(),
  numberStrategy: new DefaultInvoiceNumberStrategy({ invoicePrefix: 'RE', creditNotePrefix: 'GS' }),
  sellerStrategy: new ChannelSettingsSellerStrategy(),
  buyerStrategy: new DefaultBuyerDataStrategy(),
  formatStrategy: new DefaultInvoiceFormatStrategy(),
  pdfStrategy: new DefaultTemplatePdfStrategy(),
  pdf: { fonts: undefined, translations: { de: { invoice: 'Rechnung' } } },
  mapping: {/* hooks, see below */},
});
```

### VAT calculation

Vendure computes tax per order line; EN 16931 computes it per VAT rate on the sum. The difference is at most a few
cents.

- `'vendure'` (default): the VAT per rate is the sum of Vendure's line taxes. The invoice matches the order and the
  payment exactly. This is within the tolerance of the EN 16931 rules (±1 currency unit per rate). If the
  difference for a rate reaches `roundingFallbackThreshold`, that invoice falls back to `'en16931'`.
- `'en16931'`: tax on the sum per rate; the difference to the order total is shown as rounding amount (BT-114).

Please confirm the approach with your tax adviser.

## Customisation

### Invoice numbers

```ts
numberStrategy: new DefaultInvoiceNumberStrategy({ invoicePrefix: 'INV', creditNotePrefix: 'CN', padding: 6, yearly: false }),
```

Or implement `InvoiceNumberStrategy`: `sequenceKey()` decides which counter a document draws from (e.g. one per
channel, type and year), `format()` renders the number from the counter value. The plugin owns the counter and
guarantees it is gap-free; the number must be unique per channel.

### PDF layout

Level 1, no code: the **layout editor** in the dashboard (Settings → Invoice layout). The layout is a document of
blocks (logo, sender line, recipient, details, title, texts, line table, totals, payment, footer, page number, free
texts and images), each with a free frame on the page:

- `overflow: 'grow'` blocks take the height their content needs and continue on the next page; `fixed` blocks
  keep their frame. An `anchor` places a block below another one, so it moves with content of unknown length
  (the default layout anchors totals → line table → …).
- Saving runs the layout checks against a worst-case sample invoice: every field §14 UStG requires must be printed
  by a visible block, fixed blocks must not clip their content, frames must be on the page, two growing blocks
  must not stand side by side. Overlaps, the 5 mm border, the DIN 5008 window, small fonts and low contrast are
  warnings.
- When real data still does not fit into a fixed block, its font shrinks down to 6 pt and the content is then
  printed beyond the frame; it is never cut off, and a `LAYOUT_OVERFLOW` warning is added to the invoice's
  validation summary.

Labels can be overridden per language with `pdf.translations` (German and English are built in; the language
follows the channel default or `mapping.language`). Layouts saved before the editor (accent color and texts) are
converted when read.

Level 2: your own layout as a [pdfmake](https://pdfmake.github.io/docs/) document definition. `input.layout` is
the channel's layout document; `compileLayout`, `layoutTemplate`, `defaultTemplate`, `blockRenderers` and
`checkLayout` are exported, so you can start from the shop's layout and change details:

```ts
import { defaultTemplate, InvoicePdfStrategy, PdfTemplateInput } from '@openrootz/vendure-plugin-e-invoice';

class MyPdfStrategy implements InvoicePdfStrategy {
  buildDocDefinition(ctx: RequestContext, input: PdfTemplateInput) {
    const doc = defaultTemplate(input); // or build your own from input.model and input.labels
    return { ...doc, watermark: { text: 'COPY', opacity: 0.1 } };
  }
}
```

The plugin always enforces PDF/A-3b, embedded fonts, the attached XML and the Factur-X metadata, so a template
cannot produce a non-compliant e-invoice. Templates cannot load URLs or files; images must be data URLs.
Custom fonts: `pdf.fonts` with TTF paths (`{ MyFont: { normal, bold, italics, bolditalics } }`); the default is
Roboto (Latin, Greek, Cyrillic). A layout can pick one of them as `theme.font`.

### Other strategies and hooks

| Option                     | Default                                          | Purpose                                                                   |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| `sellerStrategy`           | `ChannelSettingsSellerStrategy`                  | seller data, bank account and payment terms                               |
| `buyerStrategy`            | `DefaultBuyerDataStrategy`                       | buyer, buyer reference, delivery address, notes                           |
| `formatStrategy`           | ZUGFeRD, + XRechnung CII with a Leitweg-ID       | which files a document gets (`zugferd`, `xrechnung-cii`, `xrechnung-ubl`) |
| `mapping.deliveryDate`     | issue date                                       | BT-72                                                                     |
| `mapping.taxCategory`      | TaxRate custom fields                            | VAT category per line, e.g. `AE` for EU B2B with VAT ID                   |
| `mapping.paymentMeans`     | PaymentMethod custom field                       | BG-16                                                                     |
| `mapping.unitCode`         | `H87` (piece)                                    | BT-130                                                                    |
| `mapping.language`         | channel default language                         | PDF language                                                              |
| `mapping.priceDisplay`     | net for business buyers, else gross              | line prices in the PDF                                                    |
| `mapping.creditAllocation` | proportional to the remaining gross per VAT rate | split of amount-only refunds                                              |
| `mapping.transformModel`   | —                                                | last-mile change of the invoice model before the checks                   |

## APIs and downloads

### Admin API

Permissions: `CreateEInvoice`, `ReadEInvoice`, `UpdateEInvoice` (retry, void, settings). `ReadEInvoice` does not
grant access to orders: `eInvoicePreview`, `eInvoiceLayoutPreview` with an `orderId` and the `EInvoice.order` field
also need `ReadOrder` (without it, `order` is `null`).

| Query / mutation                                            |                                                                                                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eInvoices(options)`                                        | list with filters and sorting (incl. `type`, `status`, `orderCode`)                                                                                             |
| `eInvoice(id)`, `Order.eInvoices`                           | documents incl. files, issues, credit notes, `remainingAmount`, `creditable`, `validation`                                                                      |
| `eInvoicePreview(orderId)`                                  | the PDF the order would get now, with a draft number; nothing is saved                                                                                          |
| `eInvoiceLayoutPreview(input)`                              | renders an unsaved layout (and unsaved seller data) with sample data or an order; returns the PDF, page count, where every block ended up and the layout issues |
| `eInvoiceDefaultLayout(preset)`                             | a layout document to start from: default, DIN 5008 Form A/B, minimal                                                                                            |
| `eInvoiceSetupStatus`                                       | what is missing in the channel                                                                                                                                  |
| `eInvoiceChannelSettings` / `updateEInvoiceChannelSettings` | seller, payment terms, layout (rejected if the layout checks report errors)                                                                                     |
| `createEInvoice(orderId)`                                   | manual invoice; returns a BLOCKED invoice with `issues` if data is missing                                                                                      |
| `retryEInvoice(id)`                                         | BLOCKED: map the order again; FAILED: render again                                                                                                              |
| `voidEInvoice(id, reason)`                                  | FAILED → VOID                                                                                                                                                   |
| `createEInvoiceCreditNote(input)`                           | lines, shipping, amount or full reversal                                                                                                                        |
| `cancelAndReissueEInvoice(invoiceId)`                       | full credit note + new invoice for the current order                                                                                                            |
| `createEInvoiceGuestLink(invoiceId, format)`                | download link valid for `guestTtl` (7 days)                                                                                                                     |
| `createEInvoiceZipLink(ids)`                                | ZIP of several issued documents                                                                                                                                 |

### Shop API

```graphql
query {
  activeCustomer {
    orders {
      items {
        code
        eInvoices {
          number
          type
          issueDate
          totalWithTax
          files {
            format
            fileName
            downloadUrl
          }
        }
      }
    }
  }
}
```

Only issued documents are visible, and only through Vendure's own ownership checks (`activeCustomer`,
`orderByCode`). Note that Vendure's default `orderByCode` access strategy lets anyone with the order code read a
guest order for 2 hours after it was placed.

### Download links

Every download goes through `GET /e-invoice/download/:id?f=<format>&exp=…&sig=…` (or `/e-invoice/zip?ids=…`). The
GraphQL API checks permissions or ownership and returns a link signed with HMAC-SHA256 over the document, format,
expiry and channel token; the route only verifies the signature, so plain `<a href>` links work. Expired links
answer `410`, invalid ones `403`. Files are checked against their SHA-256 before they are sent.

Set `downloadLinks.baseUrl` in production. Without it, links are built from the `Host` header of the request,
which a client can choose freely unless your proxy overwrites it; the plugin logs a warning the first time this
happens. It is also required behind a proxy and when creating links outside a request (e.g. in an email handler).

The download route is public (the signature is the authorization). It answers with `Cache-Control: private,
no-store`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, a sandboxing
`Content-Security-Policy` and `Referrer-Policy: no-referrer`.
To put a link into your order confirmation email, listen for `EInvoiceIssuedEvent` and use `DownloadLinkService`:

```ts
const url = injector.get(DownloadLinkService).fileLink(event.ctx, event.invoice, 'zugferd', 'guest');
```

Rotating `secret` or the channel token invalidates all links.

### Events

`EInvoiceIssuedEvent` (files are ready), `EInvoiceBlockedEvent` (checks failed, with `issues`),
`EInvoiceFailedEvent` (rendering or validation failed).

## Dashboard

The plugin ships an extension for the React dashboard (`@vendure/dashboard`), compiled by your dashboard build:

- **Order detail page**: invoices and credit notes with status, downloads and actions (create, credit note,
  cancel & reissue, retry, void, copy guest link, PDF preview). Blocked invoices list their problems with links to
  where they are fixed.
- **Sales → E-Invoices**: list with filters and ZIP download of the selection.
- **Settings → E-Invoices**: seller data, bank account, payment terms, setup status, PDF preview with sample data.
- **Settings → Invoice layout**: the visual layout editor. The real PDF (sample invoices or the latest order) is
  rendered by the server and shown with pdf.js; drag and resize blocks on the page (snapping to a 1 mm grid, the
  margins and other blocks; Shift = free; arrow keys move by 0.5 mm, with Shift by 5 mm), show or hide them, anchor
  them below growing blocks, edit texts, fonts and colors, add free texts, images and page numbers, start from a
  preset (DIN 5008 Form A/B, minimal), undo and redo. Blocks that carry content §14 UStG requires are marked and
  cannot be hidden when they are its last carrier; saving is disabled while the layout checks report errors.
- The custom fields appear in the `E-Invoice` tab of orders, customers, tax rates and payment methods.

No extra configuration is needed: `vendureDashboardPlugin` finds the extension through the plugin metadata.

## Runtime validation

Validation belongs in CI (this repository validates every scenario with KoSIT, Mustang and veraPDF). For extra
safety in production, run the [KoSIT validator](https://github.com/itplr-kosit/validator) with the XRechnung
configuration as a sidecar in daemon mode and enable:

```ts
validation: { validator: new KositHttpValidator({ url: 'http://kosit:8080/' }), mode: 'report' },
```

- `report`: every file is validated (the ZUGFeRD PDF through its embedded XML), the result is stored and shown
  (`EInvoice.validation`), the document is issued anyway.
- `enforce`: a rejected document, or one that could not be validated, is `FAILED` with the messages; retry or void it.

`test/validate/kosit-daemon.sh` shows how to start the daemon with Docker. Custom validators implement
`InvoiceValidator`.

## Storage

| Strategy                                                     |                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `DatabaseInvoiceStorageStrategy` (default)                   | files in the `e_invoice_blob` table: no setup, covered by your database backup, written in the same transaction    |
| `LocalFileInvoiceStorageStrategy({ dir })`                   | `<dir>/<channel>/<year>/<file>`; server and worker must share the directory; never use a publicly served directory |
| `S3InvoiceStorageStrategy({ bucket, prefix, clientConfig })` | needs `@aws-sdk/client-s3`; keep the bucket private                                                                |

Files are never overwritten or deleted by the plugin. Invoices must not be stored with the `AssetStorageStrategy`,
because assets are public.

## Legal notes

This plugin helps you create compliant e-invoices; it is not tax or legal advice.

- Have your tax adviser confirm your setup, in particular the VAT categories of your tax rates, the VAT
  calculation mode and your invoice texts.
- **Retention**: invoices must be kept for at least 8 years (§ 147 AO). The plugin never deletes documents; your
  storage and backups must keep them as well.
- **GDPR**: the invoice snapshot contains personal data (name, address, email). Deleting a customer in Vendure does
  not delete their invoices, because the retention obligation takes precedence. Mention this in your privacy policy.
- Each file's SHA-256 is stored and checked on download, which makes changes detectable. The plugin does not claim
  GoBD certification; your overall process (archiving, access control, procedure documentation) determines that.

## Limitations

- One seller per channel (no split invoices for multi-vendor orders yet).
- Downloads only: sending invoices by email or via Peppol is not included yet.
- A goodwill refund that happens before an invoice is cancelled and reissued is not reflected in the new invoice.
- The PDF template cannot be edited in the dashboard (code and settings only).

## Development

Requirements: Node ≥ 22, pnpm 11, Docker (Postgres for the dev server, validators).

```bash
pnpm install
pnpm test                   # unit + e2e (sql.js)
TEST_DB=postgres pnpm test  # e2e against Postgres (pnpm db:up first)
pnpm typecheck              # plugin and dashboard extension
pnpm dashboard:build        # dashboard incl. the extension → test/__output__/dashboard
pnpm db:up && pnpm dev      # dev server on http://localhost:3050 (/dashboard, superadmin / superadmin)
pnpm validate [dir]         # KoSIT (XRechnung/EN 16931), Mustang (ZUGFeRD), veraPDF (PDF/A-3b)
pnpm validate test/golden   # validate the XML of all test scenarios
UPDATE_GOLDEN=1 pnpm test   # regenerate golden files after an intended output change
pnpm validate test/__output__/pdf # validate the ZUGFeRD PDFs of all scenarios (written by pnpm test)
pnpm validate test/__output__/e2e # validate the invoices generated from e2e orders
```

The sql.js e2e tests cache their seeded database in `test/__data__/`. Delete that folder after changing
entities, custom fields or test fixtures.

## License

MIT
