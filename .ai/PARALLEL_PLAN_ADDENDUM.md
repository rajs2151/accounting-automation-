# Parallel plan addendum - UI polish, extraction fix, reports, company setup (06 Oct 2026, chat-Claude)

Extends .ai/PARALLEL_PLAN.md (same collision rules, lock, prefixes, migration ranges). Owner sets the order;
nothing here starts a new slice without Raj's OK.

| Task | File | Stream | Why there | Starts after |
|---|---|---|---|---|
| E1c real-layout invoice extraction (worker only) | NEXT_TASK_E1c.md | B (Claude Code) | document side; no stream owns worker/ - B takes it | current B task |
| UI-3 review screen (fixed viewport, read-first fields, hover chip, extracting state) | NEXT_TASK_UI-3.md | B | document review = document side | E5 PASS + E1c |
| UI-2 queues (badges, empty states, tabs) | NEXT_TASK_UI-2.md | B | purchases/sales/inbox lists | UI-3 |
| RPT-1 ReportTable + TB/Ledger/Day Book/Ageing | NEXT_TASK_RPT-1.md | B | reports + dashboard area is B | B4 dashboard |
| UI-1 shell & navigation | NEXT_TASK_UI-1.md | A (Cursor) | shell.tsx touched by nobody else; small | current A task |
| UI-4 statement review layout | NEXT_TASK_UI-4.md | A | bank side | A1-A2 |
| CS-1..3 company setup wizard (emirate, VAT reg, return period/stagger, designated zone, tolerance) | to be written | B | overlaps B2 (emirate) - write after B2 | B2 |

Prefixes: these tasks keep their own IDs ("E1c:", "UI-n:", "RPT-1:") inside the stream's branch.
File ownership additions: stream B owns worker/ (E1c), src/app/books/inbox/**, purchases/sales/inbox list pages,
src/app/books/reports/**, src/components/books/report-table.tsx, document-review-panels.tsx, pdf-page-preview.tsx
(after E5). Stream A owns src/components/shell.tsx (UI-1) and src/app/books/statements/** (UI-4).
Shared new UI pieces (status-badge.tsx, empty-state.tsx) are created by whichever task lands first; the other
stream imports them and never edits them in parallel.
