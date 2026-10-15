TASK ID: RPT-1
PHASE: Reports 1 - shared ReportTable + Trial Balance / Ledger / Day Book / AP-AR ageing (UI + read-only API)

OBJECTIVE:
One shared report table with accounting behaviour (group tree, pinned totals, drill-down to the source document,
period + comparison columns, exports) used by Trial Balance and Account Ledger, plus two new read-only reports:
Day Book and AP/AR Ageing. Reference: docs/reference/tofu/UI-PATTERNS.md section 13 (Reports, from Tally review).

CONTEXT:
- Pages today: src/app/books/reports/trial-balance/page.tsx, src/app/books/reports/account-ledger/page.tsx,
  src/app/books/journals/page.tsx. Server: src/server/books/trial-balance.ts, journals.ts, open-items.ts (read only
  here - owned by stream A), saved-views.ts. Grid: src/components/books/data-grid.tsx.
- Stream rules: .ai/PARALLEL_PLAN.md + .ai/PARALLEL_PLAN_ADDENDUM.md. This is stream B work.

FILES TO INSPECT:
- the files above, src/app/api/books/[...path]/route.ts, src/lib/money.ts, src/lib/date.ts, e2e/*.spec.ts

IMPLEMENTATION REQUIREMENTS:
1. src/components/books/report-table.tsx: tree rows (group -> ledger), expand/collapse + "expand all"; Debit / Credit
   columns right-aligned tabular-nums, blank for zero, negatives in brackets on statements; sticky header; pinned
   footer rows supplied by the caller (e.g. Opening / Current total / Closing, Grand total). If grand totals differ,
   a red "Difference" row is shown (never hidden). Row click -> drill-down callback. Keyboard: arrows, Enter = drill,
   Backspace/Esc = up. Header shows company, period, "AED".
2. Report header bar: period picker (existing periods), view preset Monthly (one column per month in range),
   Compare preset (this period | previous period | difference). Presets only - no user formulas.
3. Drill-down chain with breadcrumbs: TB group -> ledgers -> Account Ledger -> journal entry -> source document
   (inbox review page with its highlight when the entry has a document). Returning restores filters + scroll.
4. Trial Balance and Account Ledger move onto ReportTable with identical numbers (existing tests must still pass;
   TB grouped by account type/group; Ledger footer Opening / Current total / Closing).
5. Day Book (/books/reports/day-book): all posted entries in a date range; columns Date, Particulars (first
   counter-account / party), Type (Purchase, Sales, Receipt, Payment, Journal...), Number, Debit, Credit; filter by
   type; row -> entry.
6. Ageing (/books/reports/ageing?side=ap|ar): open items as of a date: Date, Ref, Party, Pending amount, Due date,
   Overdue days; buckets Not due / 0-30 / 31-60 / 61-90 / 90+; per-party subtotals; toggle "by party". Advances and
   on-account amounts shown as their own rows if the data exists (no VAT logic).
7. Export current view to XLSX and print-friendly PDF (company, period, prepared-by, page numbers) with the same
   numbers as on screen. Use what the repo already uses for exports; no new dependency without stopping.
8. Reports are READ-ONLY: no add / duplicate / delete / cancel entry actions anywhere in reports.
9. Read-only server functions for Day Book and Ageing in NEW files (src/server/books/day-book.ts,
   src/server/books/ageing.ts) reading journals / open items with the existing RLS session; routes appended to the
   API router (add routes only).

CONSTRAINTS:
- Worktree ..\aa-claude, branch feat/p2-stream-b. Local commits only, prefix "RPT-1:".
- No db/ migrations (if one is truly needed, use db/50-59 and STOP for owner review first).
- Do not edit stream-A files (bank-transactions.ts, settlements.ts, open-items.ts, transactions page) - read only.
- Money integer fils end to end; AED 2dp at the edge; dates dd/mm/yyyy. Theme tokens only; RTL-safe.
- Do not touch files owned by the UI-n tasks while they run (shell.tsx, inbox, purchases, sales, statements pages).

TESTS REQUIRED:
- Unit: ageing buckets at boundaries (0, 30, 31, 60, 61, 90, 91 days; not due); Day Book type mapping; ReportTable
  totals helper (difference row appears only when totals differ); monthly column split.
- Unit: TB numbers via ReportTable equal trial-balance.ts output for the existing goldens (no golden edited).
- e2e: TB -> expand a group -> ledger -> entry -> document opens; Ledger footer shows opening/closing; Day Book filter
  by type; Ageing shows a 31-60 bucket for a fixture bill; XLSX export downloads with the same grand total.
- Run tests only through scripts/ai/gates.ps1 / test-files.ps1 (shared lock). Full npm test 0 failures; typecheck; e2e.

ACCEPTANCE CRITERIA:
1. TB and Ledger on ReportTable with unchanged numbers; existing tests pass unchanged.
2. Drill-down reaches the source document from TB (e2e).
3. Day Book and Ageing correct at bucket boundaries (unit) and render (e2e).
4. Exports match on-screen totals. No mutation actions in reports. No test skipped/narrowed.

DO NOT:
- push, force-push, reset, rebase other branches, delete branches
- edit golden expected values / ground_truth; disable/skip/narrow tests
- implement P&L / Balance Sheet (Phase 6) or VAT on advances (owner policy pending)
- edit stream-A owned files; run `git add -A` blindly

STOP CONDITIONS:
- A migration or new dependency seems necessary -> STOP and describe it.
- Numbers from ReportTable differ from trial-balance.ts -> STOP, report the diff (do not "fix" the TB logic here).
- When done, write the report to .ai/runs/<run>/report.md (or the path given) and stop.
