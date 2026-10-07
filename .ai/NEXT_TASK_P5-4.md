TASK ID: P5-4
PHASE: Phase 5 - Trial Balance completeness + year-end closing entry + Golden v5

OBJECTIVE:
Finish Phase 5: TB matches the spec (opening / Dr movement / Cr movement / closing, grouped by type with subtotals,
red banner if out of balance, period or as-of picker, drill-down - RPT-1 built most of it on ReportTable; fill only
the gaps), a system year-end closing entry, and a Golden v5 month test.

READ FIRST: .ai/HOW_TO_WORK.md; spec docs/plan/arnibooks-cursor-prompts.md lines 341-349. PORT the year-end logic
from legacy src/server/statements.ts yearEndCloseToRE. Existing: src/server/books/trial-balance.ts,
src/app/books/reports/trial-balance/page.tsx, report-table.tsx, P5-1 close checklist.

REQUIREMENTS:
1. TB: verify the columns/grouping/banner/as-of/drill-down against the spec; add only what is missing. Numbers must
   stay identical (existing TB tests + "Desert Falcon Jun TB matches hand-computed golden" unchanged).
2. Year-end close: for the last period of the fiscal year (fiscal-year start month on the company), "Close year"
   (approver) creates ONE system entry entry_type 'closing' dated the last day of the year: every income/expense
   account (PL_*) zeroed against 3200 Retained earnings. Allowed only when that period's close checklist passes
   (P5-1); idempotent (refuse a second closing entry for the same year); reversible only by an approver with reason.
   P&L reports for the year must exclude the closing entry (expose a flag so P6 can exclude it).
3. Golden v5: one synthetic test company month with: sales invoice (SR), purchase bill, bank receipt + payment
   matched, depreciation (P5-2), FX revaluation (P5-3), one accrual via P4-3 template. Expected TB written by hand
   in the test (comment the arithmetic). TB must equal it exactly and balance.
TESTS: closing entry lines exact (hand-computed), refused before checklist passes, refused twice, P&L for the year
after closing still shows the year's profit (closing excluded), RE increases by net profit; golden v5 exact.
ACCEPTANCE: Phase 5 spec items all covered or explicitly deferred; full gates green.
