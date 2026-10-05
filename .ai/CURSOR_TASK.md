TASK ID: TEST-ISO-1
PHASE: Test infrastructure - stop parallel tests polluting the shared DESERT company (part 1 of 2)

OBJECTIVE:
Give tests that WRITE (documents, journals, approvals, inbox items) their own synthetic company, so they cannot change
DESERT's balances, voucher counters or audit counts while other test files run in parallel. Part 1: the helper, a
guard test, and the first 3 test files. (Part 2 moves the rest.)

CONTEXT:
- npm test runs `tsx --test` over many files in parallel (package.json "test") against ONE fresh database.
- 9 test files use DESERT (e1000001-0000-4000-8000-000000000001):
  read-only goldens (must stay on DESERT): src/server/books/trial-balance.test.ts, company-a-golden.test.ts
  writers: c1-validation.test.ts, c1-money-checks.test.ts, inbox-review.test.ts, phase1.test.ts, journals.test.ts,
           schedule-post.test.ts, phase0-gaps.test.ts (all under src/server/books/)
- Real failures caused by this: C1-1 iteration 1 (KPI totals and audit counts changed by other files), and a later
  attempt where uploads posted into DESERT June and broke "Desert Falcon Jun TB matches hand-computed golden".
  A rejected workaround disabled journal immutability triggers and deleted other journals - never do that.
- Posting requires a synthetic tenant (assertSyntheticTenant in src/server/books/documents.ts), COA accounts
  (1210, 2110, 2210, 1430, 1220, 2310, 4100, 6600 ...), VAT codes, monthly periods, and Omar (preparer) /
  Layla (approver) access. Seeds: db/02-seed.sql, db/17-books-seed.sql, db/20-books-coa-v2.sql, db/22*,
  db/24-books-phase1-seed.sql, db/25-books-slice1.sql.

FILES TO INSPECT:
- package.json "test" script; src/server/books/*.test.ts (existing helpers, how they connect as admin vs app user)
- the seed files above (how DESERT, its COA, VAT codes, periods and user access are created)
- src/server/books/documents.ts (assertSyntheticTenant), src/server/books/c1-validation.test.ts (own-party pattern)

IMPLEMENTATION REQUIREMENTS:
1. Test helper (e.g. src/server/books/test-company.ts, test-only code) createTestCompany(label): creates a NEW
   synthetic client (unique name/id per call), copies DESERT's chart of accounts, VAT code setup and monthly periods
   (all OPEN), grants Omar (preparer/accountant) and Layla (approver) the same access they have on DESERT, and
   returns { clientId, periods, accountIdByCode }. Uses only test/admin connections; no production code changes
   unless a tiny export is needed.
2. Guard test (e.g. src/server/books/test-isolation.test.ts): scans src/**/*.test.ts and fails if a file other
   than an explicit allow-list references DESERT's id. Allow-list for now = the 2 goldens + the 4 writer files
   NOT migrated in this task (phase1, journals, schedule-post, phase0-gaps) with a comment "TEST-ISO-2".
3. Migrate c1-validation.test.ts, c1-money-checks.test.ts and inbox-review.test.ts to createTestCompany. Keep every
   assertion and expected value identical; only the company/period/account setup changes.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "TEST-ISO-1:".
- Do not change production behaviour, RLS, dual control, triggers, migrations or goldens.
- Do not disable triggers, delete journals, or skip/narrow any test.

TESTS REQUIRED:
- Full npm test 0 failures, run twice in a row via the orchestrator gate (scripts/ai/gates.ps1 unit) to show it is
  stable; typecheck passes.
- The guard test fails if you temporarily add DESERT's id to a non-allow-listed test file (describe how you checked
  in the report; do not commit that temporary change).

ACCEPTANCE CRITERIA:
1. createTestCompany exists and the 3 migrated files use it; their assertions are unchanged.
2. Guard test exists with the allow-list described above.
3. Unit gate green twice in a row; typecheck green.
4. No production code, migration, golden, or trigger changes.

DO NOT:
- push, force-push, reset, rebase, delete branches
- migrate phase1/journals/schedule-post/phase0-gaps (that is TEST-ISO-2)
- edit golden expected values, disable/skip/narrow any test, disable triggers, delete journal rows
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If a synthetic company cannot be created without a production/migration change, STOP and explain what is needed.
- When done, write the report to the path given in the prompt and stop.
