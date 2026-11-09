# @openrootz/vendure-plugin-e-invoice

> **Status: work in progress — not yet usable.**

EN 16931 e-invoicing for [Vendure](https://vendure.io) v3: issues **ZUGFeRD / Factur-X** (PDF/A-3b with embedded CII)
and **XRechnung** (CII / UBL) invoices and credit notes for your orders.

## Development

Requirements: Node ≥ 22, pnpm 11, Docker (Postgres for the dev server, validators).

```bash
pnpm install
pnpm test                 # unit + e2e (sql.js)
TEST_DB=postgres pnpm test  # e2e against Postgres (pnpm db:up first)
pnpm db:up && pnpm dev    # dev server on http://localhost:3050 (superadmin / superadmin)
pnpm validate [dir]       # KoSIT (XRechnung/EN 16931), Mustang (ZUGFeRD), veraPDF (PDF/A-3b)
pnpm validate test/golden # validate the XML of all test scenarios
UPDATE_GOLDEN=1 pnpm test # regenerate golden files after an intended output change
```

## License

MIT
