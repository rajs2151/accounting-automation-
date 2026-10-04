TASK ID: VERIFY-S1
PHASE: Addendum C slice 1 - verification and regression fix

OBJECTIVE:
Make slice 1 genuinely green: fix the 5 legacy unit tests that slice 1 broke, and turn every "pass*" row in
docs/phase1/slice1-acceptance.md into real, re-runnable evidence (or a fix).

CONTEXT:
The orchestrator's full `npm test` run (fresh daftar_test DB, all db/*.sql applied in order) fails 5 tests that passed
before slice 1. These are listed in .ai/config.json "knownUnitFailures":
1. CT report reconciles to ledger; download requires RELEASED approval
2. preparer cannot approve; Layla can release; upstream post marks stale; download logs
3. RLS: Nina firm pipeline and profile see only Harbour Cafe          (AssertionError expected true, actual false)
4. approving a proposal marks released packs STALE
5. financials identity holds; YE close to RE; gates block then allow STATEMENTS release
Four fail with: new row violates row-level security policy for table "pack_approvals" (42501).
Likely cause: slice-1 seed changes (db/02-seed.sql user emails -> @arnibooks.test, Layla role/access changes in
db/17-books-seed.sql or db/25-books-slice1.sql) no longer match what the RLS policies / legacy tests expect.
Slice 1's acceptance doc marks most rows "pass*" ("confirm by running Docker") - they were never verified by a full run.

FILES TO INSPECT:
- db/02-seed.sql, db/12-security.sql, db/17-books-seed.sql, db/25-books-slice1.sql (and the RLS policy on pack_approvals)
- src/server/ct.test.ts (#1), src/server/release.test.ts (#2), src/server/stage-g-regression.test.ts (#3, #4),
  src/server/statements.test.ts (#5)
- docs/phase1/slice1-acceptance.md
- scripts/ai/unit-inner.sh (this is how the orchestrator runs tests - reproduce failures the same way)

EXPECTED BEHAVIOR:
- All 94 unit tests pass on a fresh DB with all migrations applied in order (same as scripts/ai/unit-inner.sh).
- Legacy behaviour (release packs, Layla approval, Nina isolation, STALE marking, statements gates) is unchanged.
- Slice 1 behaviour (arnibooks.test emails, Layla approver visible in books, company match, fiscal year) still works.

IMPLEMENTATION REQUIREMENTS:
- Find the ROOT CAUSE. Fix it in seeds/migrations or app code so both legacy and books rules hold. If a legacy test
  asserted an old email literal, update the test literal only if the behaviour under test is unchanged - explain each
  such change in the report.
- Migrations must be additive/idempotent (no DROP of data; new numbered file if needed, e.g. db/26-...sql).
- Update docs/phase1/slice1-acceptance.md: replace every "pass*" with the exact test name + "pass" (verified by the
  orchestrator gate) or "fail" with reason. Remove the "confirm by running Docker" footnote.
- In .ai/config.json set "knownUnitFailures" to an empty list [] once the 5 tests pass.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "VERIFY-S1:".
- Do not touch fixtures/books-goldens/, docs/reference/, worker/ (unless the root cause is there - then explain).

TESTS REQUIRED:
- The full `npm test` must pass with 0 failures under scripts/ai/unit-inner.sh semantics.
- If you changed RLS/seed logic, add one regression test proving Layla can approve a pack AND Omar (preparer) cannot,
  under the new seed.

ACCEPTANCE CRITERIA:
1. The 5 previously failing tests pass; no other test fails or is skipped/narrowed.
2. Root cause documented in the report (file + line + why slice 1 broke it).
3. .ai/config.json knownUnitFailures is [].
4. docs/phase1/slice1-acceptance.md has no "pass*" rows left; each row names a real test.
5. e2e Phase 1 gate still passes.
6. Any new migration is additive and numbered after 25.

DO NOT:
- push, force-push, reset, rebase, delete branches
- edit golden expected values, disable/skip/narrow any test, weaken an RLS policy just to make a test pass
- commit anything under docs/reference/outputs/ or any real client data
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If fixing the root cause requires weakening a security/RLS rule or changing dual-control behaviour, STOP and explain
  in the report instead of changing it (the reviewer will escalate to the owner).
- When done, write the report to the path given in the prompt and stop.
