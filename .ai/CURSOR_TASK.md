TASK ID: E3
PHASE: Extraction (Addendum A) step 3 of 5 - API: uploads use only the worker; remove the TypeScript extractor

OBJECTIVE:
An upload only stores the file, creates the inbox item and enqueues the worker's extract_document job. The web app
no longer computes any field values. The inbox item shows Queued -> Extracting -> Needs review / Ready / Failed.

CONTEXT:
- src/server/books/inbox.ts (~lines 230-245) runs the TypeScript sync extractor src/server/books/extract-sync.ts AND
  enqueues the worker job; the worker row then replaces the sync row. The sync extractor invents values
  (fallback 100.00 + 5.00 VAT, assumes 5% VAT, forces sales_invoice, fixed bboxes from invoiceSynPdfBboxes()).
- E1/E2 made the worker produce correct invoice and bank statement extractions with page+bbox.
- Draft creation from an extraction (confirm/convert to document) lives in inbox.ts; C1-1 printed totals are filled
  from the extraction; C1-2 case 7 re-routes only on exact sales_invoice classification. Both must keep working
  with the worker's fields_json shape.

FILES TO INSPECT:
- src/server/books/inbox.ts, src/server/books/extract-sync.ts, src/server/books/jobs.ts,
  src/app/api/books/[...path]/route.ts, src/app/books/inbox/[id]/page.tsx (status only)
- src/server/books/inbox-review.test.ts, c1-money-checks.test.ts, c1-validation.test.ts (consumers of extractions)
- worker/src/daftar/extraction/__init__.py (fields_json shape written by the worker)

IMPLEMENTATION REQUIREMENTS:
1. Upload path: store file + inbox item (status queued) + enqueue extract_document. No sync field extraction.
2. Remove from the runtime path: parseInvoiceFieldsFromText, pdfTextFromStreams, the 100.00/5.00 fallbacks,
   invoiceSynPdfBboxes as runtime data. Delete dead code; keep only what tests still need as fixtures, moved under a
   test-only location.
3. Inbox/review API returns status + error reason; the review page shows "Extracting..." and refreshes until the
   worker finishes (no viewer changes - that is E5).
4. Draft creation and printed totals read the worker's fields_json (value + source). Missing values stay empty.
5. Exactly one books_extractions row per inbox item per run; retry replaces it.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "E3:".
- No worker/ changes (if the worker shape is insufficient, STOP and describe what is missing).
- Do not change dual control, RLS, periods, voucher numbering, C1-1/C1-2 rules.

TESTS REQUIRED:
- Port tests that relied on the sync path to use worker-shaped extraction rows (insert fields_json as the worker
  writes it). Keep their assertions.
- Unit: upload -> inbox item queued + one extract_document job + zero field values written by the web app.
- e2e: existing upload/review e2e still passes (it may need to wait for the worker; use the e2e worker or insert the
  worker-shaped extraction in setup - explain which).
- Full npm test 0 failures; typecheck; e2e green.

ACCEPTANCE CRITERIA:
1. No field values are produced by TypeScript at runtime (report lists removed code).
2. Status flow visible; one extraction row per run.
3. C1-1/C1-2 tests still pass unchanged in meaning.

DO NOT:
- push, force-push, reset, rebase, delete branches
- change worker/ or the review viewer component
- edit golden expected values, disable/skip/narrow any test, weaken any RLS rule
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If removing the sync path changes C1-1/C1-2 behaviour in a way that needs a decision, STOP and explain.
- When done, write the report to the path given in the prompt and stop.
