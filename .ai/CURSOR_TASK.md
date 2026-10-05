TASK ID: E2
PHASE: Extraction (Addendum A) step 2 of 5 - worker: bank statement PDFs -> statement + lines (Python only)

OBJECTIVE:
In the Python worker only: recognise bank statement PDFs and extract header (bank, IBAN, currency, period, opening,
closing) and lines (date, description, debit, credit, running balance, each with page + bbox), run the balance check,
and write books_statement_extractions + books_statement_lines. No web/TypeScript changes.

CONTEXT:
- Plan: docs/plan/arnibooks-cursor-prompts-addendum-C.md C2 (lines 131-163): multi-IBAN statements split per account,
  balance gate opening + credits - debits = closing and running-balance continuity, else status needs_review.
- worker/src/daftar/extraction/__init__.py (~line 222) already inserts books_statement_extractions for
  bank/card/gateway statements, but bank_c_multi_iban.pdf was not classified as a statement on the running app.
- E1 added page-aware word_boxes and field source page+bbox for invoices - reuse that.
- Shelved, UNVERIFIED reference: branch wip/demo-1-shelved worker/src/daftar/parsers/bank_statement_pdf.py. Its
  multi-IBAN split invented an empty second statement (opening 0, closing 0, "balance_ok") - do not repeat that.

FILES TO INSPECT:
- worker/src/daftar/extraction/__init__.py, extraction/classify.py, parsers/bank_uae_b.py, parsers/*
- fixtures/extraction/pdfs/bank_a.pdf, bank_b_bilingual.pdf, bank_c_multi_iban.pdf + ground_truth + text/
- db/23-books-phase1.sql (books_statement_extractions, books_statement_lines columns)

IMPLEMENTATION REQUIREMENTS:
1. Classify bank statements by content (IBAN, opening/closing balance, transaction table), not filename.
2. Extract header + lines; integer minor units; dates ISO; each line has source page + bbox.
3. Multi-IBAN: one statement per IBAN with its own lines and balances, taken from the document. If a section's
   balances are not printed, its statement is needs_review with reason "balances_not_found" - never invent 0/0.
4. Balance check per statement; failure -> needs_review with the difference.
5. Dedupe within a re-upload (same file twice -> no duplicate lines).

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "E2:".
- Python worker + fixtures ONLY. No changes under src/, e2e/, db/ (if a column is missing, STOP and say which).
- Integer minor units. Synthetic fixtures only.

TESTS REQUIRED (pytest; run via scripts/ai/gates.ps1 pytest):
- bank_a and bank_b_bilingual: header and every line match ground_truth; balance check passes.
- bank_c_multi_iban: one statement per IBAN; each matches ground_truth where ground_truth has values; sections
  without printed balances are needs_review "balances_not_found" (not 0/0).
- A tampered copy (one line amount changed) -> needs_review with the right difference.
- E1 invoice tests still pass.

ACCEPTANCE CRITERIA:
1. pytest gate green; bank_a/b/c behave as above.
2. Lines carry page+bbox; nothing invented for missing balances.
3. No changes outside worker/ and fixtures/.

DO NOT:
- push, force-push, reset, rebase, delete branches
- change src/, e2e/, db/; post statement lines to the journal; implement bank matching (Phase 2)
- edit existing ground_truth or golden files, disable/skip/narrow any test
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If a ground_truth file looks wrong versus its PDF, STOP and list it (owner decides).
- When done, write the report to the path given in the prompt and stop.
