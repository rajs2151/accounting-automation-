TASK ID: VERIFY-S1-fix1
PHASE: Addendum C slice 1 - verification (owner review of 6b1af5a)

OBJECTIVE:
Narrow db/26 so the approver role gets only the rights it needs to approve and release, nothing more.

CONTEXT:
6b1af5a correctly found the root cause (approver role missing from legacy Stage B RLS) and fixed Nina's access.
But db/26-books-approver-release-rls.sql grants `approver` INSERT, UPDATE **and DELETE** on release_packs,
pack_approvals and download_events. An approver must never be able to delete approval records or download logs -
those are the audit trail of dual control. Owner decision: least privilege for approver.

FILES TO INSPECT:
- db/26-books-approver-release-rls.sql
- the original Stage B policies (db/06-release-packs.sql, db/12-security.sql) - keep admin/accountant rights exactly as
  they were before db/26 (do not change legacy behaviour for those roles)
- src/server/release.test.ts

IMPLEMENTATION REQUIREMENTS:
- Do NOT edit db/26 (it may already be applied on existing volumes). Add db/27-books-approver-least-privilege.sql that
  recreates the policies so that:
  * admin / accountant: same INSERT/UPDATE/DELETE rights as before db/26 (restore originals exactly).
  * approver: release_packs -> UPDATE only; pack_approvals -> INSERT only; download_events -> INSERT only.
    No DELETE for approver anywhere. No approver UPDATE on pack_approvals or download_events.
- Idempotent (DROP POLICY IF EXISTS / CREATE), no data deleted.

TESTS REQUIRED (add to src/server/release.test.ts, using the app role connection like the existing tests):
- Layla (approver) can still approve/release a pack (existing test keeps passing).
- Layla (approver) DELETE on pack_approvals affects 0 rows / is denied; same for download_events.
- Layla (approver) cannot UPDATE an existing pack_approvals row.
- Omar (preparer) still cannot approve his own pack.

ACCEPTANCE CRITERIA:
1. db/27 exists, is additive/idempotent, numbered after 26; db/26 untouched.
2. Approver has exactly: UPDATE release_packs, INSERT pack_approvals, INSERT download_events.
3. admin/accountant policies identical to the pre-db/26 originals (state the original file+lines in the report).
4. New tests above pass; full npm test 0 failures; e2e gate passes.
5. Do not commit docs/phase1/*.png re-captures, and do not leave scratch files in .ai/ (unit-before.txt etc.).

DO NOT:
- push, force-push, reset, rebase, delete branches
- edit golden expected values, disable/skip/narrow any test, weaken any RLS rule
- commit docs/phase1/*.png, anything under docs/reference/outputs/, or real client data
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If the application genuinely needs approver DELETE/UPDATE somewhere, STOP and explain in the report (owner decides).
- When done, write the report to the path given in the prompt and stop.
