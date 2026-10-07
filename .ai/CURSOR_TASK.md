TASK ID: P7-2
PHASE: Phase 7 - Company Health (next after P7-1)

OBJECTIVE:
Receivables / payables trackers + payment behaviour (DSO, DPO, cash conversion cycle) on Company Health.
Do NOT implement until owner says "go" if starting a new phase slice mid-chat — this follows a green P7-1.

READ FIRST: .ai/HOW_TO_WORK.md; docs/plan/arnibooks-cursor-prompts.md Phase 7 §2–3;
existing ageing (`src/server/books/ageing.ts`) — reuse open items, do not invent balances.

PROPOSED SLICE P7-2:
1. Extend health API: AR/AP tracker rows (party, doc, amount fils, due date, days overdue, status);
   DSO / DPO / CCC (DIO only if inventory accounts present) current vs prior.
2. UI tabs: wire "Debtors & Creditors" + payment behaviour strip on Dashboard.
3. Rule-based insight stubs optional (or defer to P7-3).
4. Unit tests hand-computed DSO/DPO; e2e smoke on debtors tab.

OUT OF SCOPE: firm multi-company board, LLM insights, partner offers, Golden v6.
