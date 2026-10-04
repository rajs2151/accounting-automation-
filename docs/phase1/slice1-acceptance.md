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
| Review loads extraction for uploaded inbox id | `inbox-review.test.ts` + e2e upload `invoice_02.pdf` | pass* |
| Review 404 for unknown inbox id | same | pass* |
| Fields show INV-SYN-002 (not INV-SYN-001 demo) | e2e `field-invoice_no` | pass* |
| Preview file sha256 = uploaded bytes | e2e hash of signed URL body | pass* |
| Near-miss TRN ≠ TRN exact label | `company-match.test.ts` + pytest | pass* |
| Name fuzzy → needs_review, not TRN | same | pass* |
| Fiscal year start month on company (≠ books-start) | Settings field + `fiscal-year.test.ts` | pass* |
| Voucher series year = fiscal year | `assignEntryNo` uses `fiscalYearForDate` | pass* |
| Users `@arnibooks.test` | `db/02-seed.sql` + `db/25-books-slice1.sql` | pass |
| Banner dismiss localStorage try/catch | `security-banner.tsx` | pass |
| Purchases Uploads tab + retry | UI + `/inbox/:id/retry` | pass* |
| Screenshot of NEW uploaded fixture in review | `docs/phase1/review-uploaded-invoice-02.png` | pass* |

Verified: slice1 unit tests **8 passed**; e2e gate **3 passed**.

## Screenshots

| Screen | File |
|---|---|
| Review (uploaded invoice_02 → INV-SYN-002) | `docs/phase1/review-uploaded-invoice-02.png` |
| Review (alias) | `docs/phase1/review-split-view.png` |
| Purchases (Uploads tab) | `docs/phase1/purchases.png` |

## Apply migration on existing Docker volume

```powershell
docker compose exec -T postgres psql -U daftar -d daftar -f - < db/25-books-slice1.sql
```
