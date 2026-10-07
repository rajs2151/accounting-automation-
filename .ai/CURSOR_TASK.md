TASK ID: P7-1
PHASE: Phase 7 - Company Health (plan first; wait for go)

OBJECTIVE:
Start Company Health: ledger-backed metrics + firm dashboard foundation.
Do NOT implement until owner says "go".

READ FIRST: .ai/HOW_TO_WORK.md; docs/plan/arnibooks-cursor-prompts.md Phase 7 (lines 408–434);
docs/reference/crossval/ health screens (layout only — Arnifi branding).

PROPOSED SLICE P7-1 (for owner approval):
1. Server module `src/server/books/health.ts`: cash on hand, avg net cash flow (last 3 months),
   runway (cash / avg monthly net burn; "n/a — cash positive" if no burn), liabilities/assets ratio;
   each with vs-prior change. Integer fils end-to-end. Journal SoT only.
2. API GET `/api/books/health/summary?periodId=`
3. UI: `/books/health` shell with tabs stubbed; Dashboard tab shows the four metrics + formulas on hover.
4. Unit tests on createTestCompany hand-computed amounts; one e2e smoke that Dashboard loads.
5. No LLM insights yet (P7-2+); no partner offers; no industry benchmarks.

OUT OF SCOPE THIS SLICE: scorecard, runway charts, AR/AP trackers, DSO/DPO, firm multi-company board,
Golden v6 (still waiting on owner fixtures).

ACCEPTANCE (when go): exact fils math, full gates green, commit/push on feat/books-phase1.
