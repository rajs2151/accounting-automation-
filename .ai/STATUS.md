# arnibooks - Project status (maintained by the AI loop + reviewer)

## Now
- Phase: 1 (engine shipped 117c803) -> Addendum C slice 1 verified -> C1 in progress
- Current task: DEMO-1 (upload extraction for invoices + bank statements, Upload statement button)
- Done: POC-001 PASS (6d007c1) · VERIFY-S1 (6b1af5a) + VERIFY-S1-fix1 PASS (83c8752) · C1-1 PASS (5755744, 02c7976) | C1-2 PASS (39b7bfc + fix1 484e04f)
- Owner gate: every slice boundary needs Raj's approval; loop never starts a new slice by itself.
  2026-10-05 ~00:15: Raj delegated approvals to Claude for ~2-3 h overnight (no push, no security/dual-control weakening).
- CEO demo build: tag demo-ceo-2026-10-05 (957529f) is what runs in the web container on :43123; db/26-28 applied to
  the dev DB (backup: C:\Users\Raj\arnibooks-backups\pre-demo-20261005.dump). Do NOT rebuild web before the demo.

## Queue (next tasks, in order - reviewer may refine)
1. (done) POC-001 · VERIFY-S1 · VERIFY-S1-fix1 · C1-1
2. C1-2 - C1 validation matrix (8 cases from addendum-C.md lines 64-73) + check_vat acknowledgement
3. C1-3 - Item/Accounting mode, Approve & Next, party mismatch banner (UI)
4. C1b sales record-only parity | 5. C2 Banking + statements

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
