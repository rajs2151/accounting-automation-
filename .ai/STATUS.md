# arnibooks - Project status (maintained by the AI loop + reviewer)

## Now
- Phase: 1 (engine shipped 117c803) -> Addendum C slice 1 verified -> C1 in progress
- Current task: E3 (uploads use only the worker; remove TypeScript extractor)
- 2026-10-05 16:50 owner decisions on E2: (1) ambiguous multi-IBAN activity -> two statements, both needs_review,
  attribute by position, flag account_attribution_ambiguous, never 'ready'; (2) bank ground_truth filled from
  generate_synthetic.py constants BANK_A/B/C (owner-approved ground_truth edit, those 3 files only).
- Done today: PYTEST-0 (a94497f) | E1 (b649886, c7fbb67) | E2 (20f6674, 069baf3, b32abe0)
- 2026-10-05 13:xx owner decision: smaller one-layer tasks. DEMO-1 shelved on branch wip/demo-1-shelved (0f6cb7e,
  unverified; contains a rejected trigger-disabling hack in trial-balance.test.ts - never merge). Extraction redone
  the Addendum A way (worker = single extractor) as E1-E5. Task files wait in .ai/NEXT_TASK_*.md.
- Loop changes: scripts/ai/gates.ps1 (Cursor runs the same gates), pytest gate uses cached venv
  (scripts/ai/pytest-inner.sh), timeout no longer crashes the loop, .gitattributes forces LF for *.sh.
- Done: POC-001 PASS (6d007c1) Â· VERIFY-S1 (6b1af5a) + VERIFY-S1-fix1 PASS (83c8752) Â· C1-1 PASS (5755744, 02c7976) | C1-2 PASS (39b7bfc + fix1 484e04f)
- Owner gate: every slice boundary needs Raj's approval; loop never starts a new slice by itself.
  2026-10-05 ~00:15: Raj delegated approvals to Claude for ~2-3 h overnight (no push, no security/dual-control weakening).
- CEO demo build: tag demo-ceo-2026-10-05 (957529f) is what runs in the web container on :43123; db/26-28 applied to
  the dev DB (backup: C:\Users\Raj\arnibooks-backups\pre-demo-20261005.dump). Do NOT rebuild web before the demo.
- 2026-10-05 ~17:45: localhost updated to tag local-e2-2026-10-05 (E1+E2, worker+web rebuilt; db/29-30 applied;
  backup C:\Users\Raj\arnibooks-backups\pre-e2-20261005.dump). Demo build still tagged demo-ceo-2026-10-05.

## Queue (next tasks, in order - reviewer may refine)
1. (done) POC-001 Â· VERIFY-S1 Â· VERIFY-S1-fix1 Â· C1-1 Â· C1-2 Â· TEST-ISO-1 (ace66e8, 5b8a9b4, 4763c34 - also
   covered TEST-ISO-2's scope: only the 2 read-only goldens use DESERT, enforced by test-isolation.test.ts)
3. PYTEST-0 - fix 3 pre-existing worker pytest failures (statements_extraction_method_check x2, forced RLS test)
   (pytest gate first ran for real 2026-10-05: 32 pass / 3 fail at HEAD)
4. E1 worker invoice fields + page/bbox -> E2 worker bank statements -> E3 API worker-only upload ->
   E4 Upload statement UI -> E5 multi-page viewer
4. C1-3 - Item/Accounting mode, Approve & Next, party mismatch banner (UI)
5. C1b sales record-only parity | 6. C2 remaining (bank accounts page, coverage/gaps)

## Known issues / open decisions
- Test (VERIFY-S1-fix1 review): approver least-privilege test does not first prove Layla can SELECT the rows before showing DELETE/UPDATE change 0 rows - add a row-count check in a later task.
- Company A month-1 golden is PROVISIONAL - owner to supply hand-computed values (Claude offered to prepare).
- VAT on customer advances: policy TBD (not implemented).
- Real reference file docs/reference/outputs/*.xlsx is gitignored; only anonymised copies may be committed.
- Pending inputs: brand hex + font; B/C opening balances.

## Log
(the loop appends one line per run: date | task | iteration | decision | run folder)
- 2026-10-04 15:53 | POC-001 | i1 | NEEDS_HUMAN_DECISION | .ai/runs/20261004-153155-POC-001-i1
- 2026-10-04 20:13 | POC-001 | i1 | PASS | .ai/runs/20261004-200719-POC-001-i1
- 2026-10-04 21:54 | VERIFY-S1-fix1 | i1 | PASS | .ai/runs/20261004-214314-VERIFY-S1-fix1-i1
- 2026-10-04 23:37 | C1-1 | i1 | FAIL | .ai/runs/20261004-232143-C1-1-i1
- 2026-10-04 23:52 | C1-1 | i2 | PASS | .ai/runs/20261004-233756-C1-1-i2
- 2026-10-05 00:17 | C1-2 | i1 | FAIL | .ai/runs/20261004-235830-C1-2-i1
- 2026-10-05 ~00:40 | C1-2 | i2 | KILLED (Claude Code stopped the loop: Windows RAM ~0.3 GB free). Cursor's uncommitted
  i2 fix left in src/server/books/inbox.ts + c1-validation.test.ts; scripts/_diag-tb-tmp.sh is a Cursor scratch file.
  Next: owner restarts loop (C1-2 i2 fix for case 7 re-routing), then swap in .ai/NEXT_TASK_DEMO-1.md.
- 2026-10-05 10:57 | C1-2-fix1 | i1 | PASS | .ai/runs/20261005-104227-C1-2-fix1-i1
- 2026-10-05 12:05 | DEMO-1 | i1 | FAIL | .ai/runs/20261005-105927-DEMO-1-i1
- 2026-10-05 15:14 | TEST-ISO-1 | i1 | FAIL | .ai/runs/20261005-145854-TEST-ISO-1-i1
- 2026-10-05 15:25 | TEST-ISO-1 | i2 | FAIL | .ai/runs/20261005-151433-TEST-ISO-1-i2
- 2026-10-05 15:32 | TEST-ISO-1 | i3 | PASS | .ai/runs/20261005-152522-TEST-ISO-1-i3
- 2026-10-05 15:46 | PYTEST-0 | i1 | PASS | .ai/runs/20261005-153350-PYTEST-0-i1
- 2026-10-05 16:04 | E1 | i1 | FAIL | .ai/runs/20261005-154808-E1-i1
- 2026-10-05 16:17 | E1 | i2 | PASS | .ai/runs/20261005-160417-E1-i2
- 2026-10-05 16:45 | E2 | i1 | NEEDS_HUMAN_DECISION | .ai/runs/20261005-161902-E2-i1
- 2026-10-05 17:16 | E2-fix1 | i1 | FAIL | .ai/runs/20261005-164758-E2-fix1-i1
- 2026-10-05 17:39 | E2-fix1 | i2 | PASS | .ai/runs/20261005-171632-E2-fix1-i2
