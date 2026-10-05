TASK ID: PYTEST-0
PHASE: Test infrastructure - make the worker pytest suite green before extraction work (E1/E2)

OBJECTIVE:
Fix the 3 worker pytest failures that already exist on feat/books-phase1 (they were never seen because the loop's
pytest gate could not run until 2026-10-05). Find root causes; do not weaken tests or security.

CONTEXT (orchestrator pytest gate, scripts/ai/gates.ps1 pytest, 2026-10-05 ~14:00: 32 passed, 3 failed):
1. tests/test_acceptance.py::test_text_pdf_does_not_use_ocr_and_scanned_pdf_does
2. tests/test_acceptance.py::test_image_fixture_matches_expected_amounts
   Both: psycopg.errors.CheckViolation: new row for relation "statements" violates check constraint
   "statements_extraction_method_check" - the worker writes an extraction_method value the legacy statements table
   (db/*.sql) does not allow (likely a newer OCR route name from Addendum A, e.g. docTR/easyocr).
3. tests/test_acceptance.py::test_forced_rls_and_set_local_is_transaction_scoped - `assert False` at
   worker/tests/test_acceptance.py:426.
The gate runs worker tests in python:3.12 against the compose postgres (daftar_test, all db/*.sql applied by
worker/tests/conftest.py) and MinIO at http://minio:9000. See scripts/ai/pytest-inner.sh.

FILES TO INSPECT:
- worker/tests/test_acceptance.py (around the 3 tests), worker/tests/conftest.py
- db/*.sql: the statements table and its extraction_method CHECK; RLS/SET LOCAL setup used by test 3
- worker/src/daftar/extract.py, worker/src/daftar/pipeline.py (where extraction_method is set)

IMPLEMENTATION REQUIREMENTS:
- Root cause for each failure, with file + line, in the report.
- If the CHECK constraint is outdated vs Addendum A's routes, extend it in a NEW migration (next free number,
  additive/idempotent: drop + recreate the constraint with the old values plus the new ones). Do not remove allowed
  values. If instead the worker writes a wrong value, fix the worker.
- Test 3: fix the real cause (RLS/SET LOCAL behaviour); never weaken an RLS policy or the assertion.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "PYTEST-0:".
- Keep the change small (worker/, db/ new migration if needed, worker/tests only).

TESTS REQUIRED:
- scripts/ai/gates.ps1 pytest: 35 passed, 0 failed. scripts/ai/gates.ps1 unit: still green (new migration must not
  break npm tests). typecheck green.

ACCEPTANCE CRITERIA:
1. pytest gate 0 failures; unit gate still 0 failures.
2. Root causes documented; any migration additive/idempotent; no RLS weakened; no test narrowed/skipped.

DO NOT:
- push, force-push, reset, rebase, delete branches
- weaken RLS, delete allowed CHECK values, skip/narrow tests, edit goldens
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If fixing test 3 requires changing a security rule, STOP and explain (owner decides).
- When done, write the report to the path given in the prompt and stop.
