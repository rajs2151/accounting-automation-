TASK ID: P6-1
PHASE: Phase 6 - Financial statements engine (server only): P&L, Balance Sheet, Cash Flow + period engine + gates

OBJECTIVE:
One read-only server module that builds P&L, Balance Sheet and indirect Cash Flow for any set of period columns,
with integrity gates. No UI in this task (P6-2 builds the screens).

READ FIRST: .ai/HOW_TO_WORK.md; spec docs/plan/arnibooks-cursor-prompts.md lines 354-404 (sections 2-4 and 9 gates).
PORT from legacy src/server/statements.ts (buildFinancialStatements, evaluateIntegrity, StatementLine types) -
same ideas, books tables. Data: books journals (posted + reversed, same rule as trial-balance.ts), books_accounts
(statement_line BS_* / PL_*, sub_type), P5-4 closing entry flag (exclude from P&L), fiscal year on the company.

REQUIREMENTS:
1. Period engine: columns Monthly / Quarterly / Yearly / custom range, fiscal-year aware; a column covering a
   partial current period is labelled MTD/QTD/YTD and compared like-for-like (same number of days last period) -
   never a half month vs a full month.
2. P&L (movements per column): Revenue (PL_revenue) -> COGS (PL_cogs) -> Gross profit -> Operating expenses
   (PL_opex excluding sub_type depr/amort) -> EBITDA -> Depreciation & amortisation (sub_type depr/amort) -> EBIT
   -> Other income / finance costs (PL_other: interest, FX, disposal) -> EBT -> Corporate tax (PL_tax) -> Net
   profit. Tree: section -> account; each row carries account ids for drill-down.
3. Balance Sheet (balances at column end): Assets (current BS_current_assets / non-current BS_nca incl. contra
   accounts) = Liabilities (BS_current_liab / BS_ncl) + Equity (BS_equity + current-year profit to date, before the
   year-end closing entry). Gate: must balance exactly.
4. Cash Flow (indirect, per column): net profit -> non-cash (depreciation/amortisation sub_type, unrealised FX 7310)
   -> working capital changes (AR 1210, AP 2110, prepaid, accrued, VAT 2210/1430, inventory, deferred revenue 2310,
   clearing accounts) -> operating; investing (BS_nca fixed/intangible movement net of non-cash); financing
   (capital 3100, drawings 3400, loans BS_ncl) -> net change -> opening cash -> closing cash. Cash = accounts flagged
   bank/card/cash (1110/1120/1121...; reuse the money-account definition from P2B-3/B4, excluding P&L accounts).
   Gate: closing cash = sum of those account balances.
5. Integrity gates object: tbBalances, bsBalances, cfTies (each bool + difference in fils). Exports (P6-3) are
   blocked unless all are true.
6. API: GET reports/pnl, reports/balance-sheet, reports/cash-flow with ?mode=monthly|quarterly|yearly|range&from&to
   (append-only route registrations). RLS session as other reports. Read-only.
TESTS (hand-computed in the test): a test company with revenue, COGS, opex, depreciation, interest, FX unrealised,
CT expense, AR/AP/VAT movements, a fixed asset purchase, capital injection, drawings -> exact P&L subtotals
(GP, EBITDA, EBIT, EBT, NP), BS balances, CF ties to cash; monthly vs quarterly columns sum correctly; MTD column
labelled and compared like-for-like; closing entry excluded from P&L but reflected in BS equity.
ACCEPTANCE: exact numbers, three gates, full gates green. Golden v6 for A/B/C is NOT in this task (owner values).
