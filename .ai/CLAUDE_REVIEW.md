# Review - PYTEST-0 iteration 1

**Decision: PASS**

Cursor fixed all three worker pytest failures, and both fixes address the real causes. The test files were not changed. Failures 1 and 2 happened because the worker wrote the raw OCR engine name (doctr, easyocr or tesseract) into statements.extraction_method, but the CHECK constraint in db/01-schema.sql only allows csv, xlsx, pdf_text, ocr and mixed. Cursor fixed this in the worker (pipeline.py now maps engine names to 'ocr' at document level) rather than widening the constraint, which is the correct choice. Failure 3 happened because four tables (books_coa_template, books_vat_codes, books_free_zone_emirate, books_ref_sequences) had no row-level security, while the test requires FORCE RLS on every public table. The new migration db/30 is additive and idempotent. It enables and forces RLS on those tables, gives the three global reference catalogs a read-all policy, and gives books_ref_sequences tenant and role policies copied exactly from books_entry_sequences. This makes security stricter, not weaker. The orchestrator re-ran the gates: pytest 35 passed / 0 failed, unit 112 pass / 0 fail / 1 skip, typecheck clean, e2e 3 passed. The one skip is the existing company A golden test, which is still marked PROVISIONAL and awaiting your hand-computed values, which is correct.

- [PASS] 1. pytest gate 0 failures - gates/pytest.log: '35 passed, 6 warnings'. The three target tests (test_text_pdf_does_not_use_ocr_and_scanned_pdf_does, test_image_fixture_matches_expected_amounts, test_forced_rls_and_set_local_is_transaction_scoped) are all PASSED
- [PASS] 1. unit gate still 0 failures (migration must not break npm tests) - gates/unit.log: '# tests 113 / # pass 112 / # fail 0 / # skipped 1'. scripts/ai/unit-inner.sh applies every db/*.sql, so migration 30 was included. The only skip is the existing PROVISIONAL golden (ok 35)
- [PASS] typecheck green - gates/typecheck.log PASS (package.md)
- [PASS] 2. Root causes documented with file + line - cursor-report.md cites extract.py ~244-265 (engine names in extraction.methods), pipeline.py _extraction_method falling through to next(iter(methods)), the CHECK at db/01-schema.sql:101, and the four RLS-less tables with the migration that created each. Checked against test_acceptance.py:426 (an all-tables relrowsecurity/relforcerowsecurity assert)
- [PASS] 2. Any migration additive/idempotent; no CHECK values removed - db/30-pytest0-force-rls-reference.sql only does ENABLE/FORCE RLS plus DROP POLICY IF EXISTS / CREATE POLICY. It is guarded by to_regclass, drops no tables or columns, and leaves the statements CHECK untouched
- [PASS] 2. No RLS weakened - Every change makes RLS stricter. The books_ref_sequences policies match books_entry_sequences (db/18-books-phase0.sql:41-45). Its only writer, books_next_display_ref, is called from journals.ts:536 inside withUser during draft creation, the same role scope as entry sequences, and the unit/e2e gates passed with it in place
- [PASS] 2. No test narrowed/skipped - git diff 5b82285..a94497f touches only db/30, worker/src/daftar/pipeline.py and worker/tests/conftest.py (one line adding migration 30). test_acceptance.py is unchanged, the assert at line 426 is intact, and pytest collected 35 items as before

Needs human validation: 

Question: 
