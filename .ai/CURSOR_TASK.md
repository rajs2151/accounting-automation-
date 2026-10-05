TASK ID: DEMO-1
PHASE: Phase 1 - upload extraction must work end-to-end for the CEO demo (2026-10-05)

OBJECTIVE:
Uploading a synthetic bill/invoice PDF or a bank statement PDF through the UI must produce usable extracted fields
(invoice) or a statement with lines in Statement staging (bank). Today only invoice_02.pdf is proven by e2e.

CONTEXT (observed 2026-10-05 ~00:30 on the running app, Docker web at tag demo-ceo-2026-10-05, user Omar, company
DESERT e1000001-0000-4000-8000-000000000001, via POST /api/books/inbox/upload):
- fixtures/extraction/pdfs/invoice_03.pdf (ground truth: sales_invoice INV-SYN-003, 2026-05-15, total 10500,
  TRN 100000000000001) -> inbox status needs_review, detectedType null, classificationConfidence 0.3, clientId null,
  fields: party null, document_date null, one line "invoice_03.pdf" amount 0.
  validationFlags: no_rule_match, methods:1:pdf_text, company_match:no_identifiers, company_mismatch, unassigned,
  low_confidence_classification.
- fixtures/extraction/pdfs/bank_c_multi_iban.pdf -> same result (detectedType null, conf 0.3, clientId null);
  NO row appeared in GET /api/books/statements (only the seeded "Synthetic UAE Bank" demo statement exists).
- The PDF has text (methods pdf_text), so this is parsing/classification, not OCR.
- Two extraction paths exist: web sync path src/server/books/extract-sync.ts (used on upload) and worker
  worker/src/daftar/extraction/__init__.py process_extract_document (creates books_statement_extractions for
  bank/card/gateway statements at ~line 222). Find which path ran and why no parser/rule matched.
- Statements page src/app/books/statements/page.tsx has NO upload control (only a Stripe CSV textarea).

FILES TO INSPECT:
- src/server/books/inbox.ts, src/server/books/extract-sync.ts, src/app/api/books/[...path]/route.ts (upload route)
- worker/src/daftar/extraction/__init__.py, worker/src/daftar/extraction/classify.py, worker/src/daftar/parsers/*
- fixtures/extraction/{pdfs,ground_truth,text}/ and fixtures/extraction/README.md
- src/app/books/statements/page.tsx, src/app/books/statements/[id]/page.tsx, src/server/books/statement-extractions.ts

IMPLEMENTATION REQUIREMENTS:
1. Root cause first: explain in the report why invoice_03 and bank_c get no_rule_match while invoice_02 works.
2. Invoices/bills: every fixtures/extraction/pdfs/invoice_01..10.pdf uploaded via the upload API must get the
   correct doc type, invoice number, date, party name/TRN and total per its ground_truth JSON (no hardcoding per
   filename or per fixture - fix the general parser/classifier). Company match: if the document carries the company's
   own TRN/name, it must be assigned to that company, not "unassigned".
3. Bank statements: bank_a.pdf, bank_b_bilingual.pdf, bank_c_multi_iban.pdf uploaded via the inbox must be classified
   as bank_statement and create books_statement_extractions + books_statement_lines (opening, closing, lines,
   balance check) matching ground_truth; multi-IBAN splits per account (C2 spec, addendum-C.md lines 143-153).
4. Add an "Upload statement" button on /books/statements (PDF/CSV) that uses the same inbox upload with
   userDocType=bank_statement and shows the new statement in the list when extraction finishes.
5. Do not post bank lines to the journal and do not build bank matching (that is Phase 2).

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "DEMO-1:".
- Synthetic fixtures only; no real client data. Integer minor units. Follow .cursor/rules/arnibooks.mdc.
- Do not change dual control, RLS, periods, voucher numbering, or C1-1/C1-2 approve checks.
- Any DB change = new migration numbered after the highest existing one, additive/idempotent.

TESTS REQUIRED:
- Unit/integration test that uploads each invoice_01..10 fixture through the same code path as the upload API and
  asserts doc type, number, date, total against ground_truth (allow a documented per-field tolerance only for OCR'd
  scans, none for text PDFs).
- Test that bank_a/b/c uploads create statement extractions with lines and a passing balance check (multi-IBAN -> one
  statement per IBAN).
- If the worker (Python) changes: pytest for the parser/classifier changes (scripts/ci-local-pytest.sh).
- e2e: extend e2e/books-phase1.spec.ts: upload bank_a.pdf from /books/statements -> statement appears with lines.
- Full npm test 0 failures; pytest passes; e2e passes; typecheck passes.

ACCEPTANCE CRITERIA:
1. Root cause stated with file + line.
2. All 10 invoice fixtures extract correctly via the upload path (test proves it).
3. All 3 bank fixtures create statements with lines and balance check via the upload path (test proves it).
4. /books/statements has a working Upload statement button (e2e proves it).
5. No fixture-specific hardcoding; no test skipped/narrowed; no goldens edited.

DO NOT:
- push, force-push, reset, rebase, delete branches
- post statement lines to the journal or implement bank matching / reconciliation (Phase 2)
- edit golden expected values or ground_truth files, disable/skip/narrow any test, weaken any RLS rule
- commit docs/phase1/*.png, anything under docs/reference/outputs/, or real client data
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If a ground_truth file looks wrong versus its PDF, STOP and list it in the report (owner decides) - do not edit it.
- When done, write the report to the path given in the prompt and stop.
