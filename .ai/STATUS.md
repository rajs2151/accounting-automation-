# arnibooks — Project status (maintained by the AI loop + reviewer)

## Now
- Phase: 1 (engine shipped 117c803) → Addendum C slice 1 in progress (uncommitted on feat/books-phase1 at loop setup)
- Current task: POC-001 (loop proof of concept)
- Owner gate: every slice boundary needs Raj's approval; loop never starts a new slice by itself.

## Queue (next tasks, in order — reviewer may refine)
1. POC-001 — hide UI gallery outside development (loop proof)
2. VERIFY-S1 — run all gates on Addendum C slice 1 and turn every "pass*" row in docs/phase1/slice1-acceptance.md into
   real evidence or a fix
3. C1 remaining gaps — see docs/plan/arnibooks-cursor-prompts-addendum-C-gaps.md (KPI tiles, Item/Accounting mode,
   totals vs printed totals, journal preview, payments-made info only, C1 validation matrix)
4. C1b sales record-only parity · 5. C2 Banking + statements

## Known issues / open decisions
- Company A month-1 golden is PROVISIONAL — owner to supply hand-computed values (Claude offered to prepare).
- VAT on customer advances: policy TBD (not implemented).
- Real reference file docs/reference/outputs/*.xlsx is gitignored; only anonymised copies may be committed.
- Pending inputs: brand hex + font; B/C opening balances.

## Log
(the loop appends one line per run: date · task · iteration · decision · run folder)
