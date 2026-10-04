# Slice 1 acceptance — real review + carry-overs

Addendum C file was missing at implement time; gaps listed in
[`docs/plan/arnibooks-cursor-prompts-addendum-C-gaps.md`](../plan/arnibooks-cursor-prompts-addendum-C-gaps.md).
C3 (per-account bank txn review) is Phase 2.

## Demo-path sweep

| Location | Found | Replacement |
|---|---|---|
| `src/app/books/inbox/[id]/page.tsx` `buildDemoExtraction()` | Runtime hardcoded INV-SYN-001 + `/books-demo/…png` | `GET /api/books/inbox/:id` → `books_extractions` + MinIO signed URL |
| `src/lib/review-bbox.ts` `invoiceSyn001DemoBboxes` | Still used by unit tests only | PDF-space `invoiceSynPdfBboxes()` for real pdf.js preview |
| `public/books-demo/*` | Static assets remain on disk | No runtime reference from review page |
| Worker / `src/server/books` | No `buildDemo*` runtime fixtures | Sync extract writes real `books_extractions` on upload |

## Acceptance table

| Requirement | Evidence | Pass |
|---|---|---|
| Review loads extraction for uploaded inbox id | `review API returns books_extractions for uploaded inbox id; 404 for unknown` (`inbox-review.test.ts`) | pass |
| Review 404 for unknown inbox id | same test (`BooksError` not_found) | pass |
| Fields show INV-SYN-002 (not INV-SYN-001 demo) | e2e `phase1 screenshots: review from NEW upload…` (`field-invoice_no`) + unit parse/PDF tests | pass |
| Preview file sha256 = uploaded bytes | `review API returns books_extractions…` asserts `review.sha256` | pass |
| Near-miss TRN ≠ TRN exact label | `near-miss TRN does not match as TRN` (`company-match.test.ts`) | pass |
| Name fuzzy → needs_review, not TRN | `name-only match → needs_review, not auto-assigned, never labelled TRN` | pass |
| Fiscal year start month on company (≠ books-start) | `default January FY = calendar year` + `April FY start rolls back Jan–Mar` (`fiscal-year.test.ts`); Settings field | pass |
| Voucher series year = fiscal year | `sales invoice approve → SV voucher + open item; disbursement uses 1220` (`SV-2026-…`) | pass |
| Users `@arnibooks.test` | `db/02-seed.sql` + `db/25-books-slice1.sql`; `seed roles: Layla approver can release pack; Omar preparer cannot` | pass |
| Banner dismiss localStorage try/catch | `security-banner.tsx` `readDismissed` / `writeDismissed` try/catch | pass |
| Purchases Uploads tab + retry | e2e `phase1 screenshots: review from NEW upload…` (purchases.png) + UI `/inbox/:id/retry` | pass |
| Screenshot of NEW uploaded fixture in review | `docs/phase1/review-uploaded-invoice-02.png` | pass |

Verified: full `npm test` via `scripts/ai/unit-inner.sh` (94 tests, 0 failures after VERIFY-S1); e2e Phase 1 gate.

## Screenshots

| Screen | File |
|---|---|
| Review (uploaded invoice_02 → INV-SYN-002) | `docs/phase1/review-uploaded-invoice-02.png` |
| Review (alias) | `docs/phase1/review-split-view.png` |
| Purchases (Uploads tab) | `docs/phase1/purchases.png` |

## Apply migration on existing Docker volume

```powershell
Get-Content db/25-books-slice1.sql, db/26-books-approver-release-rls.sql | docker compose exec -T postgres psql -U daftar -d daftar -v ON_ERROR_STOP=1
```
