TASK ID: P7-3
PHASE: Phase 7 - Company Health (next after P7-2)

OBJECTIVE:
Company Scorecard tab, Cash Flow & Runway charts, Profitability trends, rule-based insight cards (no LLM).
Firm multi-company dashboard remains a separate slice.

READ FIRST: .ai/HOW_TO_WORK.md; docs/plan/arnibooks-cursor-prompts.md Phase 7 §1–3;
reuse P7-1 health.ts + P7-2 debtors API; fs-chart-series for runway/profit charts.

PROPOSED SLICE P7-3:
1. Scorecard: composite tiles (close status, TB gate, overdue AR/AP from health/debtors).
2. Runway tab: multi-month cash + runway chart from existing CF columns.
3. Profitability tab: gross margin % + opex by category (P&L sections over time).
4. Insight cards: threshold rules (runway &lt; 6 mo, DSO &gt; 45, overdue concentration).
5. Unit tests on insight triggers; e2e smoke one new tab.

OUT OF SCOPE: firm board (§4), partner offers, Golden v6, B2 VAT pack.

WAIT: owner "go" on P7-2 commit/push before starting P7-3 if gates not green locally.
