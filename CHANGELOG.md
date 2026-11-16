# Changelog

## 0.1.0 (unreleased)

First release.

- ZUGFeRD / Factur-X (EN 16931 profile, PDF/A-3b with embedded CII) and XRechnung (CII, UBL) from one EN 16931
  invoice model; validated with KoSIT, Mustang and veraPDF in CI
- Automatic invoices on a configurable order state, manual invoices, plausibility checks before a number is used
  (BLOCKED invoices with explanations and retry)
- Gap-free numbering with a row-locked counter per sequence; number format via `InvoiceNumberStrategy`
- Credit notes for settled refunds (amount-only refunds split across the VAT rates), cancellations and order
  modifications; manual credit notes per line, for shipping, a free amount or a full reversal; cancel and reissue.
  `EInvoice.reason` tells why a document was created (`auto`, `manual`, `refund`, `cancellation`, `modification`,
  `reissue`)
- PDF with a built-in German/English template, logo, accent color and texts from the channel settings, or a
  custom pdfmake layout via `InvoicePdfStrategy`
- Admin API: invoice list, preview, setup status, retry, void, settings; Shop API: issued documents of the
  customer's orders
- Format warnings for the seller data (`eInvoiceSetupWarnings`, shown on the settings page): country code, EU VAT ID
  structure, IBAN length and check digits, BIC, email addresses. Saving normalizes country code, VAT ID, IBAN and BIC
- Permissions `CreateEInvoice`, `ReadEInvoice` and `UpdateEInvoice`, with descriptions for the role editor; there
  is no delete permission, as issued documents are never deleted
- Signed, time-limited download links, guest links and ZIP export; files are checked against their SHA-256
- Optional runtime validation (`KositHttpValidator`, report or enforce)
- Storage in the database (default) or a local directory; other storage through a custom `InvoiceStorageStrategy`
- Dashboard extension: invoices on the order page, credit note dialog, invoice list, settings page
- Live layout preview: `eInvoiceLayoutPreview` renders an unsaved layout with sample invoices (business, consumer,
  credit note, many lines, worst case) or an order, without saving anything
- Visual layout editor: the PDF layout is a document of blocks with free frames (grow or fixed, anchors, pages);
  layout checks for §14 UStG content, clipping (against a worst-case sample), page bounds, overlaps, the DIN 5008
  window and readability; presets; the editor renders the real PDF with pdf.js. Layouts from the channel settings
  (accent color, texts) are converted automatically. `PdfTemplateInput.layout` is now the layout document.

### Security

- `eInvoicePreview`, `eInvoiceLayoutPreview` with an `orderId` and `EInvoice.order` require `ReadOrder` in
  addition to `ReadEInvoice`; `EInvoice.order` is nullable and `null` without it
- The download routes reject malformed IDs and repeated query parameters before querying the database (they
  could cause `500` responses), and send `Content-Security-Policy: default-src 'none'; sandbox` and
  `Referrer-Policy: no-referrer`
- `downloadLinks.baseUrl` must be an http(s) URL; a warning is logged when links are built from the `Host` header
- CI runs with a read-only `GITHUB_TOKEN`
- `createEInvoiceGuestLink` requires `CreateEInvoice` instead of `ReadEInvoice`; the dashboard shows "Copy guest
  link" only with that permission
- Guest links created outside the Admin API require `downloadLinks.baseUrl` instead of using the `Host` header
- ZIP downloads pack every document once and no longer overwrite a file when two documents share a file name
