# Addendum C reconcile (Slice 1) — gaps vs plan

**Note:** `docs/plan/arnibooks-cursor-prompts-addendum-C.md` was not present in the workspace at implement time.
Gaps below are from the user brief (amendment 0) + AI Accountant README workflow notes. Re-check when C lands.

## Covered in Slice 1

| Item | Status |
|---|---|
| Real review by inbox id (MinIO file + `books_extractions`) | done |
| Remove runtime `buildDemoExtraction` | done |
| Uploads tab statuses + retry (Purchases) | done (basic) |
| Company match evidence (TRN / IBAN / name fuzzy → needs review) | done |
| Fiscal year start month + voucher series per FY | done |
| Emails `@arnibooks.test` | done |
| Banner dismiss via localStorage (try/catch) | done |
| Settings About + build SHA | done |
| Sales/Purchases primary “Upload Invoices” + Record manually | done (partial) |
| C3 bank txn Needs Review → Ready → Posted | **out of scope** (Phase 2) |

## Not covered yet (C1 / C1b / C2) — carry to later slices

| Gap | Notes |
|---|---|
| KPI tiles from open items (AR/AP ageing tiles on sales/purchases home) | C1 |
| Item mode vs Accounting mode toggle on invoice form | C1 |
| Totals vs printed totals blocking Approve | C1 validation |
| Journal preview before/after approve | C1 / C1b drawer |
| “Payments made” stored as info only (not settlement) | C1 |
| Full C1 validation test matrix from addendum | C1 |
| Sales Uploads tab parity (queue UI) | C1b — purchases Uploads done; sales upload goes to inbox |
| Parties C2 polish (duplicate suggest UI, TRN validation UX) | C2 |
| Approve & Next queue flow | C1b |
| Side peek on bank lines (C3) | Phase 2 |

When `arnibooks-cursor-prompts-addendum-C.md` is available, diff this list against C1/C1b/C2 headings and expand.
