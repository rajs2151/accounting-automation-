# AI Accountant reference screenshots (Indian product — workflow reference only)

Use for **WORKFLOW and LAYOUT only**. Do not copy branding, copy text, colours or Indian tax concepts.

Spec that governs these screens: [`docs/plan/arnibooks-cursor-prompts-addendum-C.md`](../../plan/arnibooks-cursor-prompts-addendum-C.md) (C1, C1b, C2, C3).

## UAE mapping (when reading Indian UI)

| Reference concept | arnibooks |
|---|---|
| GSTIN | TRN |
| GST treatment | VAT treatment |
| CGST / SGST | single VAT 5% (standard) |
| Source / destination of supply | place of supply (emirate) |

**Not built** (ignore in reference UI): HSN/SAC, godown, cost-centre class, multi-GST branch.

## Do NOT replicate (errors / out of scope)

- Sync to Tally — in arnibooks, **approve = post to our journal**
- Manually typed tax ledger lines — VAT is **computed from VAT codes**
- Invoice number blank until sync; outstanding > total; approved invoices with no customer
- Separate voucher date ≠ document date
- "Debit" label on money in — show **In / Out**
- Statement uploadable to the wrong bank account — we detect from **IBAN**
- Opening balance field on vendor/customer forms — openings only via **opening-balance import**
- Invoice issuing / printing / customisation — arnibooks is **record-only**

## Screenshot inventory

Drop anonymised PNG/JPG captures into this folder (no real client TRNs, names, or IBANs). Suggested naming:

| File prefix | Screen (workflow) | Addendum |
|---|---|---|
| `c1-sales-` | Sales invoices list / create / drawer | C1 |
| `c1b-purchase-` | Purchase bills upload → review → approve | C1b |
| `c2-parties-` | Customers & vendors | C2 |
| `c3-statements-` | Bank / card statement staging & review | C3 |

CrossVal remains the Phase 0 ledger/TB visual reference under [`docs/reference/crossval/`](../crossval/). This pack is the Phase 1+ document workflow reference under Addendum C.

## Source pack

Original local dump (host): `Downloads/new ss before build` — copy into this directory before committing; do not commit real client data.
