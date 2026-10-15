TASK ID: C1b-2
PHASE: Addendum C — Apply customer advance on sales approve

OBJECTIVE:
When approving a sales invoice, if the customer has an unallocated 2320 advance,
show an optional "Apply advance" control (off by default). If the accountant ticks
it and sets an amount ≤ min(advance, invoice gross), after post allocate
Dr 2320 / Cr AR and reduce the open item. Never auto-apply.

CONTEXT:
- allocatePartyAdvance already exists in settlements.ts (phase1 test covers it).
- approveAndPostBooksDocument creates the open item; no UI/API for apply-on-approve yet.
- VAT-on-advances when *receiving* cash remains TBD — this task only allocates existing 2320.

FILES:
- src/server/books/settlements.ts (getPartyAdvanceBalance)
- src/server/books/documents.ts (optional applyAdvanceOriginalMinor on approve)
- src/app/api/books/[...path]/route.ts
- src/components/books/document-review-panels.tsx
- unit test in c1-money-checks or phase1
- .ai/STATUS.md

CONSTRAINTS:
- feat/books-phase1. Commit "C1b:". No push.
- Never allocate by default. Cap amount. Dual control: preparer = doc.created_by.
- No CN apply in this slice. No new deps.

TESTS:
- Unit: approve with applyAdvance reduces 2320 and open item; without flag advance unchanged.
- Full gates.

DO NOT:
- invent VAT on advances; auto-apply; push
