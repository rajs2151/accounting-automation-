# arnibooks - Project status (maintained by the AI loop + reviewer)

## Now
- Phase: 1 (engine shipped 117c803) -> Addendum C slice 1 verified -> C1 in progress
- Current task: P2A stream A — A1–A4 done (Phase 2 bank side)
- 2026-10-06: P2A-4 PASS — card repayment / gateway payout + group net-zero; Unmatched→post e2e
- 2026-10-06: P2A-3 PASS — bank rules (conditions→actions), preview, Rule: chip, create-from-txn
- 2026-10-06: P2A-2 PASS — weighted match scores, bands, reject memory, subset-sum bundle
- 2026-10-06: P2A-1 PASS — split allocations 1:N/N:1 + fees; unallocated=0; advance VAT TBD flagged
- 2026-10-06: C3-3 PASS — transfer pair link → one Contra (CV); dual-control post both sides.
- 2026-10-06: C3-2 PASS — 1:1 open-item match + dual-control post (RV/PY or category JV).
- 2026-10-06: C3-1 PASS — bank txns Needs Review / Ready / Excluded; categorize only (no journal post).
- 2026-10-06: C2-2 PASS — intended account on upload, IBAN≠account block, sample CSV, statement logs.
- 2026-10-06: C1b-2 PASS — apply customer advance on sales approve (optional, never default).
- 2026-10-06: C2-1 PASS — Banking page, coverage/gaps, setup gate, COA link.
- 2026-10-06: C1b PASS — sales Uploads/tabs parity + manual record reason gate.
- 2026-10-06: C1-3 PASS — Item/Accounting, Approve & Next, party mismatch, purchases tabs/bulk.
- 2026-10-06: E1d PASS (71cde5b) — confirm/UI never invent SR; block until VAT picked.
- 2026-10-06: E1c PASS (24a77ca) + UI-3-fix1 scroll/flags PASS (8e9b4f9). Queue:
  **C1b follow-up | polish backlog**
- 2026-10-05: E4 + E5 + UI-1..UI-4 PASS on feat/books-phase1 (pushed).
- 2026-10-05 16:50 owner decisions on E2: (1) ambiguous multi-IBAN activity -> two statements, both needs_review,
  attribute by position, flag account_attribution_ambiguous, never 'ready'; (2) bank ground_truth filled from
  generate_synthetic.py constants BANK_A/B/C (owner-approved ground_truth edit, those 3 files only).
- Done today: PYTEST-0 | E1 | E2 | E3 | E4 | E5
- Claude did directly (owner request 2026-10-05): login picker + synthetic owner Raj (db/31), worker NUL-safe text +
  garbled pages -> OCR (E3b), duplicate upload notice + per-company file hash (db/32), readable errors with ref,
  faster Docker builds, parallel typecheck, scripts/ai/test-files.ps1, scripts/dev-local.ps1, ~/.wslconfig
- 2026-10-05 13:xx owner decision: smaller one-layer tasks. DEMO-1 shelved on branch wip/demo-1-shelved (0f6cb7e,
  unverified; contains a rejected trigger-disabling hack in trial-balance.test.ts - never merge). Extraction redone
  the Addendum A way (worker = single extractor) as E1-E5. Task files wait in .ai/NEXT_TASK_*.md.
- Loop changes: scripts/ai/gates.ps1 (Cursor runs the same gates), pytest gate uses cached venv
  (scripts/ai/pytest-inner.sh), timeout no longer crashes the loop, .gitattributes forces LF for *.sh.
- Done: POC-001 PASS · VERIFY-S1 + VERIFY-S1-FIX1 PASS · C1-1 PASS | C1-2 PASS
- Owner gate: every slice boundary needs Raj's approval; loop never starts a new slice by itself.
- CEO demo build: tag demo-ceo-2026-10-05 (957529f) is what runs in the web container on :43123; db/26-28 applied to
  the dev DB (backup: C:\Users\Raj\arnibooks-backups\pre-demo-20261005.dump). Do NOT rebuild web before the demo.
- 2026-10-05 ~17:45: localhost updated to tag local-e2-2026-10-05 (E1+E2, worker+web rebuilt; db/29-30 applied;
  backup C:\Users\Raj\arnibooks-backups\pre-e2-20261005.dump). Demo build still tagged demo-ceo-2026-10-05.

## Queue (next tasks, in order - reviewer may refine)
1. (done) POC-001 · VERIFY-S1 · VERIFY-S1-FIX1 · C1-1 · C1-2 · TEST-ISO-1 · PYTEST-0 · E1-E5 · UI-1..UI-4 · E1c · UI-3-fix1 · E1d · C1-3 · C1b · C2-1 · C1b-2 · C2-2 · C3-1 · C3-2 · C3-3
2. C3 follow-ups: N:1 splits, bulk post, rules (transfer pairs done in C3-3)
3. Polish backlog (Review later, paid/unpaid types, non-UAE VAT→cost, …)

## Known issues / open decisions
- Test (VERIFY-S1-FIX1 review): approver least-privilege test does not first prove Layla can SELECT the rows before showing DELETE/UPDATE change 0 rows - add a row-count check in a later task.
- Company A month-1 golden is PROVISIONAL - owner to supply hand-computed values (Claude offered to prepare).
- VAT on customer advances: policy TBD (not implemented).
- Real reference file docs/reference/outputs/*.xlsx is gitignored; only anonymised copies may be committed.
- Pending inputs: brand hex + font; B/C opening balances.
- UI polish backlog (not in UI-1..4): Review later status, paid/unpaid types, non-UAE VAT->cost, knowledge cards,
  stale extraction, snippet split, settings CSV, firm overview, email-in, E1b worker confidence.
- E1c report: SR default is in src/server/books/inbox.ts confirmInboxAsDocument and review UI normalizeLines
  (not the worker) — tracked as E1d.

## Log
(the loop appends one line per run: date | task | iteration | decision | run folder)
- 2026-10-04 15:53 | POC-001 | i1 | NEEDS_HUMAN_DECISION | .ai/runs/20261004-153155-POC-001-i1
- 2026-10-04 20:13 | POC-001 | i1 | PASS | .ai/runs/20261004-200719-POC-001-i1
- 2026-10-04 21:54 | VERIFY-S1-FIX1 | i1 | PASS | .ai/runs/20261004-214314-VERIFY-S1-FIX1-i1
- 2026-10-04 23:37 | C1-1 | i1 | FAIL | .ai/runs/20261004-232143-C1-1-i1
- 2026-10-04 23:52 | C1-1 | i2 | PASS | .ai/runs/20261004-233756-C1-1-i2
- 2026-10-05 00:17 | C1-2 | i1 | FAIL | .ai/runs/20261004-235830-C1-2-i1
- 2026-10-05 ~00:40 | C1-2 | i2 | KILLED (Claude Code stopped the loop: Windows RAM ~0.3 GB free). Cursor's uncommitted
  i2 fix left in src/server/books/inbox.ts + c1-validation.test.ts; scripts/_diag-tb-tmp.sh is a Cursor scratch file.
  Next: owner restarts loop (C1-2 i2 fix for case 7 re-routing), then swap in .ai/NEXT_TASK_DEMO-1.md.
- 2026-10-05 10:57 | C1-2-FIX1 | i1 | PASS | .ai/runs/20261005-104227-C1-2-FIX1-i1
- 2026-10-05 12:05 | DEMO-1 | i1 | FAIL | .ai/runs/20261005-105927-DEMO-1-i1
- 2026-10-05 15:14 | TEST-ISO-1 | i1 | FAIL | .ai/runs/20261005-145854-TEST-ISO-1-i1
- 2026-10-05 15:25 | TEST-ISO-1 | i2 | FAIL | .ai/runs/20261005-151433-TEST-ISO-1-i2
- 2026-10-05 15:32 | TEST-ISO-1 | i3 | PASS | .ai/runs/20261005-152522-TEST-ISO-1-i3
- 2026-10-05 15:46 | PYTEST-0 | i1 | PASS | .ai/runs/20261005-153350-PYTEST-0-i1
- 2026-10-05 16:04 | E1 | i1 | FAIL | .ai/runs/20261005-154808-E1-i1
- 2026-10-05 16:17 | E1 | i2 | PASS | .ai/runs/20261005-160417-E1-i2
- 2026-10-05 16:45 | E2 | i1 | NEEDS_HUMAN_DECISION | .ai/runs/20261005-161902-E2-i1
- 2026-10-05 17:16 | E2-FIX1 | i1 | FAIL | .ai/runs/20261005-164758-E2-FIX1-i1
- 2026-10-05 17:39 | E2-FIX1 | i2 | PASS | .ai/runs/20261005-171632-E2-FIX1-i2
- 2026-10-05 18:16 | E3 | i1 | FAIL | .ai/runs/20261005-175649-E3-i1
- 2026-10-05 18:35 | E3 | i2 | PASS | .ai/runs/20261005-181636-E3-i2
- 2026-10-05 22:19 | E4 | i1 | NEEDS_HUMAN_DECISION | .ai/runs/20261005-215737-E4-i1
- 2026-10-05 | E4 | PASS (c7b68ea, 3cd37f3) | E5 PASS (103d7b4) | pushed feat/books-phase1
- 2026-10-06 | E1c | PASS (24a77ca) | UI-3-fix1 | PASS (8e9b4f9)
- 2026-10-06 | E1d | PASS (71cde5b) | confirm blocks null vatCode; never invents SR
- 2026-10-06 | C1-3 | PASS | review queue chrome + purchases bulk; Assign=route; Revert=soft-delete draft
- 2026-10-06 | C1b | PASS | sales Uploads/tabs parity; manual record reason + invoice no gate
- 2026-10-06 | C2-1 | PASS | /books/banking coverage gaps + Not set up upload gate
- 2026-10-06 | C1b-2 | PASS | optional apply 2320 advance on sales approve; unit + gates
- 2026-10-06 | C2-2 | PASS | intended account + IBAN mismatch flag; sample CSV; statement logs
- 2026-10-06 | C3-1 | PASS | books_bank_transactions materialize + categorize UI; no post
- 2026-10-06 | C3-2 | PASS | match open item + dual-control post; Posted tab
- 2026-10-06 | C3-3 | PASS | transfer pair → one CV; linked_txn_id; dual control
- 2026-10-06 | P2A-1 | PASS | books_bank_txn_allocations; 1:N+fee+N:1; drawer; VAT on advances TBD
- 2026-10-06 | P2A-2 | PASS | match score engine + rejected_matches; unit 174 pass / 1 skip; e2e 4/4
- 2026-10-06 | P2A-3 | PASS | books_bank_rules; apply suggestions; preview; create-from-txn
- 2026-10-06 | P2A-4 | PASS | db/41 payout_group; card 2150 / gateway 1310; e2e Unmatched→RV link; unit 178p/1s e2e 5/5
