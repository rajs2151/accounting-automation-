TASK ID: E3-fix1
PHASE: Extraction (Addendum A) step 3 of 5 - corrective

OBJECTIVE:
Make the inbox review page show the worker's real fields_json correctly (money as AED with 2 decimals from integer fils, dates as dd/mm/yyyy), seed the e2e with the exact worker shape, delete the leftover demo bbox helper, and prove that retry re-queues correctly.

CONTEXT:
- E3 (c5b99af) made the worker the only extractor. The server side is correct and stays as it is.
- The worker writes these fields_json keys (worker/src/daftar/extraction/fields.py:250-361, worker/src/daftar/extraction/__init__.py:195-245): invoice_no, document_number, invoice_date, document_date (ISO yyyy-mm-dd), currency, supplier_trn, issuer_*/customer_*, net, vat, gross, grand_total. net/vat/gross/grand_total are INTEGER FILS. Each field is {value, confidence, status, source:{page,bbox}|null}. There is NO subtotal or vat_total key.
- src/app/books/inbox/[id]/page.tsx still uses FIELD_ORDER subtotal/vat_total/grand_total and parses them with parseFloat(value)*100. So a real worker row shows 'Grand total 10500' for AED 105.00 and no Subtotal/VAT.
- e2e/books-phase1.spec.ts insertWorkerShapedExtraction adds subtotal '100.00', vat_total '5.00' and grand_total '105.00' strings that the worker never writes. That hides the bug.
- src/lib/review-bbox.ts:89 invoiceSynPdfBboxes() is fixed demo bbox data and no longer has any importer.

FILES TO INSPECT:
- src/app/books/inbox/[id]/page.tsx (field form, normalizeFields, onFieldChange, flags — NOT the PdfPagePreview viewer component)
- src/lib/review-bbox.ts, src/lib/money.ts (formatMinor/displayToMinor), src/lib/invoice-validation.ts
- e2e/books-phase1.spec.ts, src/server/books/test-fixtures/worker-extraction.ts
- src/server/books/inbox.ts (retryBooksInboxExtract), src/server/books/inbox-review.test.ts

EXPECTED BEHAVIOR:
- For a worker row with net=10000, vat=500, gross=10500, invoice_date='2026-05-15', the review form shows Subtotal 100.00, VAT 5.00, Grand total 105.00, Invoice date 15/05/2026. 'Amounts balanced' is computed from those fils values.
- Retry sets the inbox item to 'queued', clears error, enqueues exactly one new extract_document job and writes no extraction fields from TypeScript.

IMPLEMENTATION REQUIREMENTS:
1. Add a small pure helper (e.g. src/lib/review-fields.ts) that maps worker fields_json to display fields. Money: read net/vat/gross (fall back to grand_total), integer fils -> formatMinor display string; keep the existing subtotal/vat_total/grand_total keys only as legacy fallbacks. Dates: ISO -> dd/mm/yyyy. Missing or null values -> empty string with status 'missing' (never 0, never a default).
2. page.tsx uses this helper. Validation (validateInvoiceLineSum) receives integer fils converted with displayToMinor (no parseFloat*100). The UI never shows raw fils and never shows '(fils)'. Do not touch PdfPagePreview.
3. Delete invoiceSynPdfBboxes from src/lib/review-bbox.ts. If a test still needs those boxes, move them under src/server/books/test-fixtures/.
4. e2e insertWorkerShapedExtraction must use workerInvoiceFieldsJson (or an identical literal) containing ONLY keys the worker writes — remove the subtotal/vat_total/string grand_total mirror. Add e2e assertions on the review page: field-subtotal = '100.00', field-vat_total (or the new VAT test id) = '5.00', field-grand_total = '105.00', invoice date shows '15/05/2026', and validation-flags shows the balanced message.
5. Optional cleanup: retryBooksInboxExtract may check that the object exists without downloading the full bytes, if the storage lib offers a head/stat call. Otherwise leave it.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "E3-fix1:".
- No worker/ changes. No changes to the PdfPagePreview viewer component (E5). Do not change confirmInboxAsDocument money logic, dual control, RLS, periods, voucher numbering, or C1-1/C1-2 rules.
- Follow .cursor/rules/arnibooks.mdc (integer fils, dd/mm/yyyy, AED 2 decimals).

TESTS REQUIRED:
- Unit tests for the mapping helper: (a) worker row net 10000/vat 500/gross 10500 -> '100.00'/'5.00'/'105.00'; (b) gross missing but grand_total 10500 -> '105.00'; (c) net null -> '' with status 'missing'; (d) '2026-05-15' -> '15/05/2026'; (e) legacy string subtotal '100.00' still maps to '100.00'.
- Unit test for retry: upload -> run retryBooksInboxExtract after inserting one worker-shaped extraction and setting the item to needs_review -> inbox status 'queued', error NULL, 2 extract_document jobs in total for that inbox id (upload + retry), still exactly 1 books_extractions row (the web app adds none).
- e2e as in requirement 4.
- Full npm test 0 failures; typecheck; e2e green.

ACCEPTANCE CRITERIA:
1. A review page loaded with a worker-only fields_json (no subtotal/vat_total keys) shows 100.00 / 5.00 / 105.00 and 15/05/2026 — proven by e2e assertions.
2. The e2e seed contains only worker-written keys (diff shows the subtotal/vat_total/string grand_total mirror removed).
3. invoiceSynPdfBboxes no longer exists in src/lib (grep proves it).
4. The retry unit test passes and asserts queued status, the job count and a single extraction row.
5. All existing tests still pass with the same assertions; C1-1/C1-2 tests unchanged.

DO NOT:
- push, force-push, reset, rebase, delete branches
- change worker/ or the PdfPagePreview viewer component
- edit golden expected values, disable/skip/narrow any test, weaken any RLS rule
- commit files under docs/reference/outputs, docs/phase1/*.png or any real client data
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If the worker's fields_json lacks a key the form needs (e.g. no VAT amount for some document types), STOP and describe what is missing; do not change the worker.
- If making missing values stay empty would change confirm/C1-1 behaviour (e.g. issue date currently defaults to today), do NOT change confirm; describe it in the report as an open decision.
- When done, write the report to the path given in the prompt and stop.
