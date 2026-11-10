# Security policy

## Supported versions

Security fixes are released for the latest minor version of `@openrootz/vendure-plugin-e-invoice`.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub:
[Report a vulnerability](https://github.com/OpenRootz/vendure-plugin-e-invoice/security/advisories/new)
(Security tab → Advisories → Report a vulnerability).

Include what is affected, how to reproduce it and the impact you see. We aim to answer within a week.
Once a fix is released, the advisory is published and you are credited, unless you prefer otherwise.

## Scope

Of particular interest are issues that let someone

- download or list invoices they are not entitled to (signed download links, Shop API, Admin API permissions),
- change, delete or forge issued invoices or their numbering,
- read personal data from invoices or the storage,
- run code or read files through PDF templates, layouts or uploaded images.

Problems in Vendure itself belong to the [Vendure project](https://github.com/vendure-ecommerce/vendure/security).
