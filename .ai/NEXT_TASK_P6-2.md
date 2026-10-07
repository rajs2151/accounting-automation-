TASK ID: P6-2
PHASE: Phase 6 - Reports screens: P&L | Balance Sheet | Cash Flow | Trial Balance tabs + drill-down panel

OBJECTIVE:
Screens for the P6-1 engine on the existing ReportTable, with the CrossVal-style layout and a cell drill-down panel
that can re-categorise an item via an audited reclass entry.

READ FIRST: .ai/HOW_TO_WORK.md; spec docs/plan/arnibooks-cursor-prompts.md lines 359-385; reference screenshots
docs/reference/crossval/ (P&L screens) and docs/reference/tofu/UI-PATTERNS.md section 13. Existing:
src/components/books/report-table.tsx (tree, pinned totals, drill-down, keyboard, exports), reports pages from
RPT-1, P6-1 API.

REQUIREMENTS:
1. /books/reports with tabs Profit & Loss | Balance Sheet | Cash Flow | Trial Balance (TB = existing page in the tab).
2. Column mode switch Monthly / Quarterly / Yearly / Range + "Today" jump; MTD columns labelled; previous-period
   comparison column optional.
3. Tree group -> sub-group -> account (-> bank/card source rows for P&L where available); negatives in brackets;
   K/M abbreviations with exact AED value on hover; frozen first column + horizontal scroll; subtotal rows
   (GP, EBITDA, EBIT, EBT, Net profit) styled as totals. Gate failures shown as a red banner naming the gate.
4. Cell click -> right drill-down panel: account, period, transaction count, search, list (date, description,
   amount, link to entry). "Re-categorise" per item -> creates a DRAFT reclass journal (Dr new account / Cr old,
   same amount, memo linking the original) for an approver to post - blocked in locked periods (period_locked),
   audited. Never edits the original entry.
5. Keyboard and print behave like the existing ReportTable.
TESTS: unit for the reclass-draft server function (exact lines, locked period refused, preparer cannot post own);
e2e: open P&L monthly, expand a section, click a cell, panel lists the entries; switch to Balance Sheet - balanced;
Cash Flow ties banner absent.
ACCEPTANCE: screens render the engine's numbers exactly, drill-down + reclass draft work, full gates green.
DO NOT: comments, charts, projections (P6-4); exports (P6-3).
