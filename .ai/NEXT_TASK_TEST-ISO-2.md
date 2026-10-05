TASK ID: TEST-ISO-2
PHASE: Test infrastructure - stop parallel tests polluting the shared DESERT company (part 2 of 2)

OBJECTIVE:
Move the remaining DESERT writer tests to createTestCompany (added in TEST-ISO-1) and shrink the guard test's
allow-list to the two read-only goldens.

CONTEXT:
- TEST-ISO-1 added createTestCompany (src/server/books/test-company.ts or similar) and a guard test whose allow-list
  still contains phase1.test.ts, journals.test.ts, schedule-post.test.ts, phase0-gaps.test.ts (marked "TEST-ISO-2").
- Read-only goldens that must stay on DESERT: trial-balance.test.ts, company-a-golden.test.ts.

FILES TO INSPECT:
- the helper and guard test from TEST-ISO-1
- src/server/books/phase1.test.ts, journals.test.ts, schedule-post.test.ts, phase0-gaps.test.ts

IMPLEMENTATION REQUIREMENTS:
1. Migrate phase1.test.ts, journals.test.ts, schedule-post.test.ts, phase0-gaps.test.ts to createTestCompany.
   Keep every assertion and expected value identical; only setup changes. If a test genuinely needs DESERT's seeded
   data (e.g. seeded journals), copy the minimum needed rows into the test company in the test's own setup.
2. Guard allow-list = trial-balance.test.ts and company-a-golden.test.ts only.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "TEST-ISO-2:".
- Do not change production behaviour, RLS, dual control, triggers, migrations or goldens.

TESTS REQUIRED:
- Full npm test 0 failures, run twice in a row via scripts/ai/gates.ps1 unit; typecheck passes; e2e passes.

ACCEPTANCE CRITERIA:
1. The 4 files use createTestCompany; assertions unchanged.
2. Guard allow-list contains only the 2 goldens.
3. Unit gate green twice in a row; typecheck and e2e green.

DO NOT:
- push, force-push, reset, rebase, delete branches
- edit golden expected values, disable/skip/narrow any test, disable triggers, delete journal rows
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If a test's meaning depends on DESERT specifically (not just its setup), STOP and list it in the report.
- When done, write the report to the path given in the prompt and stop.
