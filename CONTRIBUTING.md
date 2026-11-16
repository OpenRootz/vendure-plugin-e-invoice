# Contributing

Thanks for your interest in the Vendure E-Invoice Plugin. The best way to contribute is an
[issue](https://github.com/OpenRootz/vendure-plugin-e-invoice/issues): bug reports, questions and feature ideas are
all welcome there.

## Before you start

- **Bugs**: open an [issue](https://github.com/OpenRootz/vendure-plugin-e-invoice/issues) with the
  Vendure and plugin version, what you did, what you expected and what happened. For wrong invoice content, the
  `issues` or `validation` of the invoice and the relevant part of the generated XML help most (remove personal data
  first).
- **Features**: describe your use case in an issue.
- **Security issues**: never in a public issue; see [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node ≥ 22, [pnpm](https://pnpm.io) 11, Docker (Postgres for the dev server and the validators).

```bash
pnpm install
pnpm test                   # unit + e2e tests (sql.js, no Docker needed)
pnpm typecheck              # plugin and dashboard extension
pnpm lint && pnpm format:check
```

To try changes in the dashboard:

```bash
pnpm dashboard:build        # builds the dashboard with the extension
pnpm db:up && pnpm dev      # http://localhost:3050/dashboard, superadmin / superadmin
TEST_DB=sqljs pnpm dev      # the same without Docker
```

The dev server starts with a fresh database each time: a German shop in EUR with sample products, customers and
tax rates. Uploaded assets are kept in `test/__output__/assets`.

Please use pnpm; do not commit `package-lock.json` or `yarn.lock`.

## Project layout

| Path         | Content                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `src/core/`  | the EN 16931 model, CII/UBL serializers, checks and PDF rendering; **no imports from Vendure or Nest** |
| `src/`       | the Vendure plugin: entities, services, API, strategies, mapping from orders to the model              |
| `dashboard/` | the React dashboard extension                                                                          |
| `test/`      | unit and e2e tests, scenarios, golden files, validator scripts, dev server                             |

## Rules the code follows

- Money is stored and calculated in integer minor units; rates and quantities are decimal strings. No floats.
- Issued invoices are immutable. Files are only rendered from the stored snapshot, corrections are credit notes.
- Invoice numbers must stay gap-free: nothing may consume a number outside the issuing transaction.
- Output changes must keep the e-invoices valid. If you change the XML or the PDF on purpose, regenerate the golden
  files with `UPDATE_GOLDEN=1 pnpm test`, review the diff and run `pnpm validate test/golden` and
  `pnpm validate test/__output__/pdf` (CI runs the same validators).

## Pull requests

Please open an issue before a pull request, so we can agree on the approach first. Small fixes such as typos are
fine without one.

- Keep a pull request focused on one change and add tests for it.
- Document new public API (anything exported from `src/index.ts`) with JSDoc: a description, a `@category`
  (`Plugin`, `Services`, `Entities`, `Events`, `Strategies`, `Mapping`), `@default` on optional options and
  `@internal` on constructors, lifecycle methods and helpers that are exported only for the plugin itself.
- Make sure `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm format:check` pass.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
  `docs:`, `chore:`, … with an optional scope such as `fix(pdf):`).
- Add a line to `CHANGELOG.md` for user-facing changes.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
