# arnibooks - Project status (maintained by the AI loop + reviewer)

## Now
- Phase: 1 (engine shipped 117c803) -> Addendum C slice 1 in progress (uncommitted on feat/books-phase1 at loop setup)
- Current task: VERIFY-S1 (fix 5 slice-1 regressions + verify slice-1 acceptance)
- Done: POC-001 PASS (6d007c1, reviewed 2026-10-04)
- Owner gate: every slice boundary needs Raj's approval; loop never starts a new slice by itself.

## Queue (next tasks, in order - reviewer may refine)
1. (done) POC-001
2. VERIFY-S1 - run all gates on Addendum C slice 1 and turn every "pass*" row in docs/phase1/slice1-acceptance.md into
   real evidence or a fix
3. C1 remaining gaps - see docs/plan/arnibooks-cursor-prompts-addendum-C-gaps.md (KPI tiles, Item/Accounting mode,
   totals vs printed totals, journal preview, payments-made info only, C1 validation matrix)
4. C1b sales record-only parity | 5. C2 Banking + statements

## Known issues / open decisions
- 5 legacy unit tests fail at 989d9e4 (4x RLS 'pack_approvals' 42501, 1x Nina RLS assertion) - likely caused by slice-1 seed changes (Layla/emails). Listed in config.knownUnitFailures so they don't block; VERIFY-S1 must fix them and then empty that list.
- Company A month-1 golden is PROVISIONAL - owner to supply hand-computed values (Claude offered to prepare).
- VAT on customer advances: policy TBD (not implemented).
- Real reference file docs/reference/outputs/*.xlsx is gitignored; only anonymised copies may be committed.
- Pending inputs: brand hex + font; B/C opening balances.

## Log
(the loop appends one line per run: date | task | iteration | decision | run folder)
- 2026-10-04 15:53 | POC-001 | i1 | NEEDS_HUMAN_DECISION | .ai/runs/20261004-153155-POC-001-i1
- 2026-10-04 20:13 | POC-001 | i1 | PASS | .ai/runs/20261004-200719-POC-001-i1
