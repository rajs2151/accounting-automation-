TASK ID: C1-3
PHASE: Addendum C — review queue + purchases list chrome

OBJECTIVE:
Ship the C1 review/list UX gaps that are still missing after C1-1/C1-2 and UI polish:
Item/Accounting mode, Approve & Next, party mismatch banner, New supplier badge,
purchases tabs with counts, filter menu with counts, and a bulk bar
(Change type / Assign / Revert draft).

CONTEXT:
- Review already has ‹ › queue nav via prevNextInReviewQueue and Confirm → DocumentReviewPanels.
- Confirm must not invent SR (E1d). Fix confirm docType to follow detected/intended type.
- Assign has no per-user column yet → bulk Assign = route unassigned inbox items to the
  current company (existing POST …/inbox/:id/route).
- Revert draft = soft-delete unposted draft documents only (audited); never touch posted.

FILES TO TOUCH:
- src/app/books/inbox/[id]/page.tsx
- src/components/books/document-review-panels.tsx
- src/app/books/purchases/page.tsx
- src/lib/party-mismatch.ts (+ test)
- src/lib/review-queue-nav.ts (+ test for N of M)
- src/server/books/documents.ts (+ route + unit test for soft-delete draft)
- e2e/books-phase1.spec.ts (Approve & Next or queue label smoke only if cheap)

CONSTRAINTS:
- feat/books-phase1. Local commit prefix "C1-3:". No push.
- No worker changes. No ground_truth/golden edits. No new dependencies.
- Keep existing data-testids; add new ones listed in IMPLEMENTATION.

IMPLEMENTATION:
1. Review header: "Bill/Invoice {n} of {m}" (data-testid=review-queue-position).
2. DocumentReviewPanels: Approve & Next (data-testid=review-approve-next) — approve then
   call onApprovedAndNext (parent navigates to nav.nextId or stays).
3. Item | Accounting mode toggle (data-testid=line-mode-tabs). Item = current columns;
   Accounting = description, account placeholder, VAT, net, VAT amt (no qty/rate yet —
   account column read-only "—" until chart picker in a later task).
4. Party mismatch banner when selected party TRN/name differs from extracted
   (data-testid=party-mismatch-banner). Actions: Update party (PATCH) / Keep master.
5. New supplier badge when suggest returns empty for extracted supplier name+TRN
   (data-testid=new-supplier-badge).
6. confirmFields docType from detectedType / intended purchase vs sales (not hard-coded sales).
7. Purchases tabs: All | Needs Review (count) | Uploads (count). Filter menu with status counts.
8. Bulk bar on Uploads: Change type (sales_invoice|purchase_bill), Assign (route), 
   and on All/Needs Review drafts: Revert draft (soft-delete audited).

TESTS:
- Unit: party-mismatch helper; soft-delete draft rejects posted; queue position helper.
- Full gates: unit typecheck pytest e2e.

DO NOT:
- push; invent VAT; hard-delete posted; add assignee DB column; commit docs/phase1/*.png
