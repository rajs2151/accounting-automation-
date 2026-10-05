TASK ID: E4
PHASE: Extraction step 4 of 5 - UI: Upload statement on /books/statements

OBJECTIVE:
Add an "Upload statement" button on /books/statements (PDF/CSV) that uploads through the existing inbox upload with
userDocType=bank_statement, shows the statement as Extracting, and lists it with period, opening, closing, line count
and balance check when the worker finishes.

CONTEXT:
- src/app/books/statements/page.tsx has no upload control (only a Stripe CSV textarea) and lists rows by bank + status.
- E2 made the worker write books_statement_extractions + books_statement_lines (per IBAN, with balance check).
- E3 made uploads worker-only with a Queued -> Extracting -> ... status flow.
- Plan: docs/plan/arnibooks-cursor-prompts-addendum-C.md C2 statements list (line 150).

FILES TO INSPECT:
- src/app/books/statements/page.tsx, src/app/books/statements/[id]/page.tsx,
  src/server/books/statement-extractions.ts, src/app/api/books/[...path]/route.ts, src/app/books/purchases/page.tsx
  (existing upload UI pattern), e2e/books-phase1.spec.ts

IMPLEMENTATION REQUIREMENTS:
1. Upload statement button (multi-file, PDF/CSV), same upload API with userDocType=bank_statement.
2. List columns: file, bank/IBAN, period from-to, rows, opening, closing, balance check ok/failed, status.
   Failed -> reason + Retry.
3. Keep the Stripe CSV preset working.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "E4:".
- UI + list API only. No worker/, db/ changes. No journal posting, no bank matching (Phase 2).

TESTS REQUIRED:
- e2e: upload fixtures/extraction/pdfs/bank_a.pdf from /books/statements -> row appears with line count and balance
  check ok (wait for the e2e worker or explain the setup used). Screenshots only under UPDATE_SCREENSHOTS.
- Full npm test 0 failures; typecheck; e2e green.

ACCEPTANCE CRITERIA:
1. Button works end-to-end (e2e proves it); list shows the columns above.
2. No worker/db changes; no test skipped/narrowed.

DO NOT:
- push, force-push, reset, rebase, delete branches
- post statement lines to the journal; implement matching/reconciliation
- commit docs/phase1/*.png; run `git add -A` blindly

STOP CONDITIONS:
- When done, write the report to the path given in the prompt and stop.
