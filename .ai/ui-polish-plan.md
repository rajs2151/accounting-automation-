# UI polish + Tofu learnings - plan (written 05 Oct 2026 by chat-Claude)

Source: docs/reference/tofu/README.md, docs/reference/tofu/UI-PATTERNS.md (25 demo screenshots + call notes),
compared with docs/phase1/*.png. Owner asked: implement the learnings toward the end goal, without new problems,
unnecessary steps, or inconsistency with the project.

## Guardrails for every task below
- Runs AFTER E5 passes (E5 owns src/components/books/pdf-page-preview.tsx, src/lib/review-bbox.ts and
  src/app/books/inbox/[id]/page.tsx - no task here starts while E5 is open).
- One layer per task (owner decision). UI tasks touch only src/app/, src/components/, src/lib/ (UI helpers), e2e/.
  No db/, worker/, src/server/books/ (level-2), no API shape changes.
- Reuse what exists: components/ui (shadcn: select, popover, dropdown-menu, tabs, badge, tooltip, dialog, sheet,
  sonner), components/books/data-grid.tsx (books-data-grid), lucide-react, pdfjs-dist. No new dependencies
  (package.json is level-2). If a Command/combobox is needed, build it from Popover + Input + list.
- Keep every existing data-testid. E2E that uses selectOption on a replaced control is updated to the new
  interaction in the same commit (same assertions, nothing narrowed).
- Brand colour/font still pending from Raj: use the existing theme tokens; no new hard-coded colours outside the
  theme file (.cursor/rules/arnibooks.mdc rule 69).
- EN/AR: new labels go through the existing string pattern; use logical spacing (ms-/me-, start/end) so RTL works.
- Money: integer fils in data, AED 2dp at the edge; dates dd/mm/yyyy. Status colours carry meaning only.
- The "Synthetic data only . <status>" chip is a security signal (PORTAL_SECURITY_STATUS) - restyle allowed,
  removing/hiding is NOT.
- Nothing here changes approve/post logic, dual control, VAT computation or RLS.

## Order (each is its own NEXT_TASK file; owner approves each boundary)
1. UI-1  Shell & navigation            (.ai/NEXT_TASK_UI-1.md)
2. UI-2  Queues: status badges, empty states, pill tabs on lists   (.ai/NEXT_TASK_UI-2.md)
3. UI-3  Review screen polish on top of E5                          (.ai/NEXT_TASK_UI-3.md)
4. UI-4  Statement review layout                                     (.ai/NEXT_TASK_UI-4.md)
Then existing queue: C1-3 (Item/Accounting mode, Approve & Next, party mismatch banner) - add to its scope:
filter menu with counts, bulk bar on queues (Change type, Assign, Revert to draft audited), "New supplier" badge.

## Not UI - backlog, need owner decision / own slice (do NOT fold into the UI tasks)
- E1b worker: per-field confidence in fields_json (only if UI-3 shows word-level conf is not enough).
- "Review later" status (needs a db enum change -> db task).
- Paid receipt vs unpaid bill document types (C1/Phase 3; accounting policy).
- Rule: non-UAE VAT -> cost, never input VAT (REVIEWER.md + VAT logic; level-2).
- Stale-extraction flag when rules/source change after extraction (needs rules engine first).
- Company rules / knowledge cards: suggest-only from corrections, human approves, versioned, conflicts block (Phase 2).
- Snippet splitting of multi-receipt PDFs (Addendum A).
- Company settings tabs with CSV template import (own slice).
- Firm overview: Needs review per company (C4).
- Email-in / WhatsApp intake (after PORTAL_SECURITY_STATUS=PASS).
