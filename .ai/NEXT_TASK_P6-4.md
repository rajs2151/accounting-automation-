TASK ID: P6-4
PHASE: Phase 6 - Comments per account/period, Corporate tax banner, Revenue chart, Projections layer

OBJECTIVE:
The remaining Phase 6 features on the P&L screen. Split into commits P6-4a..d if large; each sub-part must be green.

READ FIRST: .ai/HOW_TO_WORK.md; spec docs/plan/arnibooks-cursor-prompts.md lines 386-396. Existing: legacy
src/app/ct/page.tsx (CT logic ideas), P6-1 engine, P6-2 screens.

a) Comments: one thread per (company, account, period) - unique; avatars, timestamps, @mentions of company users;
   unread count badge on the P&L row. New migration (books table + RLS). Audited.
b) Corporate tax banner: tax year (company fiscal year), filing due date (9 months after year end), status, and an
   ESTIMATE = 9% of taxable income above AED 375,000 (taxable income = net profit before CT for the year to date;
   label clearly "estimate - not a tax computation"; no adjustments engine).
c) Revenue chart above the P&L: selector Revenue / Expenses / Net profit; bars per column period, current value and
   % change (like-for-like for MTD), log scale on/off, AED axis. Use the charting approach already in the repo.
d) Projections: separate books_forecasts table (account, period, amount_minor, method trailing_avg_3|trailing_avg_6|
   linear|override, growth_pct); "Projections on" shows future months labelled Projected and styled differently;
   NEVER written to journals and excluded from TB/BS/CT estimate/exports of actuals.
TESTS: unique thread per row/period; mention notification row created; CT estimate exact for 300,000 (=0),
   500,000 (=11,250.00) and 375,000 (=0); projections excluded from TB/BS/exports; trailing average exact.
ACCEPTANCE: each sub-part green and committed; full gates green.
