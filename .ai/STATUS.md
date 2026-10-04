# arnibooks - Project status (maintained by the AI loop + reviewer)

## Now
- Phase: 1 (engine shipped 117c803) -> Addendum C slice 1 verified -> C1 in progress
- Current task: C1-1 (KPI tiles, printed-totals approve block, payments-made info only, journal preview)
- Done: POC-001 PASS (6d007c1) · VERIFY-S1 (6b1af5a) + VERIFY-S1-fix1 PASS (83c8752, approver least privilege)
- Owner gate: every slice boundary needs Raj's approval; loop never starts a new slice by itself.

## Queue (next tasks, in order - reviewer may refine)
1. (done) POC-001 · VERIFY-S1 · VERIFY-S1-fix1
2. C1-1 - KPI tiles, printed totals block Approve, payments-made info only, journal preview (addendum-C.md C1)
3. C1-2 - Item/Accounting mode, Approve & Next, party mismatch banner, full C1 validation matrix (8 cases)
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
