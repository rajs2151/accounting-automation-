TASK ID: C1b
PHASE: Addendum C — Sales record-only list parity

OBJECTIVE:
Bring Sales invoices to the same upload-queue UX as Purchases (C1-3), and enforce
record-only rules: upload is primary; manual create needs a reason; invoice number
required; no issue/print/send UI.

CONTEXT:
- Purchases already has All | Needs Review | Uploads, filter counts, bulk bar.
- Sales still shows a always-on manual form and no Uploads tab (gaps.md).
- Approve & Next and Item/Accounting landed in C1-3 on the shared review screen.
- Advance/credit apply-on-approve is deferred (needs its own accounting slice).

FILES TO TOUCH:
- src/app/books/sales/page.tsx
- src/server/books/inbox.ts (expose intendedType on list)
- src/server/books/documents.ts (sales_invoice: documentNumber + manual reason)
- src/app/api/books/[...path]/route.ts (pass manualRecordReason)
- unit test + light e2e assert for sales-uploads-tab
- .ai/STATUS.md

IMPLEMENTATION:
1. Sales tabs All | Needs Review (count) | Uploads (count); filter menu; bulk bar
   (Change type / Assign / Revert draft) mirroring purchases.
2. Uploads table filtered to intendedType/detectedType sales_invoice (and bank excluded).
3. Manual form collapsed behind "Record manually"; requires non-empty reason
   (data-testid=sales-manual-reason) sent as manualRecordReason; server rejects without it.
4. Server: sales_invoice create requires documentNumber; reject empty customer partyId
   (already via party_not_found).
5. Unit: outstanding open item ≤ document gross after approve; manual create without
   reason rejected; create without documentNumber rejected.
6. e2e: sales-uploads-tab visible (keep existing sales heading asserts).

CONSTRAINTS:
- feat/books-phase1. Commit prefix "C1b:". No push.
- No dworker/, no ground_truth/golden edits, no new deps.
- Do NOT implement apply-advance allocation UI (follow-up).

DO NOT:
- push; invent VAT; add issue/print/send invoice routes
