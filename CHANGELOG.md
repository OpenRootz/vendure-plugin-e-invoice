# Changelog

## 0.1.0 (unreleased)

First release.

- ZUGFeRD / Factur-X (EN 16931 profile, PDF/A-3b with embedded CII) and XRechnung (CII, UBL) from one EN 16931
  invoice model; validated with KoSIT, Mustang and veraPDF in CI
- Automatic invoices on a configurable order state, manual invoices, plausibility checks before a number is used
  (BLOCKED invoices with explanations and retry)
- Gap-free numbering with a row-locked counter per sequence; number format via `InvoiceNumberStrategy`
- Credit notes for settled refunds (amount-only refunds split across the VAT rates), cancellations and order
  modifications; manual credit notes per line, for shipping, a free amount or a full reversal; cancel and reissue
- PDF with a built-in German/English template, logo, accent color and texts from the channel settings, or a
  custom pdfmake layout via `InvoicePdfStrategy`
- Admin API: invoice list, preview, setup status, retry, void, settings; Shop API: issued documents of the
  customer's orders
- Signed, time-limited download links, guest links and ZIP export; files are checked against their SHA-256
- Optional runtime validation (`KositHttpValidator`, report or enforce)
- Storage in the database (default), a local directory or S3
- Dashboard extension: invoices on the order page, credit note dialog, invoice list, settings page
- Live layout preview: `eInvoiceLayoutPreview` renders an unsaved layout with sample invoices (business, consumer,
  credit note, many lines, worst case) or an order, without saving anything; layout page in the dashboard
