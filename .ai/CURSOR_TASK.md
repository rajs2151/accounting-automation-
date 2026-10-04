TASK ID: C1-1
PHASE: Addendum C - C1 Purchases/Sales review queue (part 1 of 2)

OBJECTIVE:
Add the C1 money checks around Approve: KPI tiles on Purchases/Sales, printed-totals check that blocks Approve,
"payments made / balance due" stored as info only, and a journal preview before Approve.
(Part 2, C1-2, will do Item/Accounting mode and the full C1 validation matrix - NOT in this task.)

CONTEXT:
Spec: docs/plan/arnibooks-cursor-prompts-addendum-C.md, section C1 (lines 15-74). Relevant lines:
- Header KPI tiles (line 24-25), Totals panel (line 53), Payments made (lines 55-56), Journal preview (lines 57-58).
Slice 1 is verified (VERIFY-S1 + VERIFY-S1-fix1). None of these four features exist yet (no matches for kpi,
printed total, journal preview, payments made in src/). books_documents has computed totals (db/23-books-phase1.sql
~line 213-217: original_total_minor, aed_total_minor, gross_minor) but no printed/extracted totals.
Approve + post is approveAndPostBooksDocument() in src/server/books/documents.ts:588; it builds journal lines with
buildPostingLines() before writing anything.

FILES TO INSPECT:
- docs/plan/arnibooks-cursor-prompts-addendum-C.md (C1)
- src/server/books/documents.ts (approveAndPostBooksDocument, buildPostingLines)
- src/server/books/open-items.ts (listBooksOpenItems)
- src/server/books/inbox.ts, src/server/books/extract-sync.ts (where extracted fields become a draft document)
- src/app/books/purchases/page.tsx, src/app/books/sales/page.tsx, src/app/books/inbox/[id]/page.tsx (review screen)
- src/app/api/books/[...path]/route.ts (API routing)
- db/23-books-phase1.sql, db/25-books-slice1.sql (schema), latest migration number in db/

IMPLEMENTATION REQUIREMENTS:
1. KPI tiles (Purchases = AP, Sales = AR), from open items of POSTED journals only:
   Total outstanding · Overdue (due date < today) · Due in next 7 days · Unmatched to bank (always "—" for now).
   AED, integer minor units in the API, formatted in the UI; exact value on hover (title attribute is fine).
   Add a server function + GET endpoint; compute in SQL or from listBooksOpenItems - do not duplicate ageing logic
   if a helper already exists.
2. Printed totals:
   - New migration (next free number after 27, additive/idempotent): nullable printed_net_minor, printed_vat_minor,
     printed_gross_minor on books_documents.
   - Fill them from the extraction when a draft is created from an upload; editable on the review form.
   - SERVER-SIDE in approveAndPostBooksDocument: if any printed_* is set and differs from the computed value
     (exact minor units, in document currency), throw BooksError("printed_totals_mismatch", "conflict") with the
     differences. If VAT > 5% of taxable net (rounding tolerance 1 minor unit per line), throw
     BooksError("vat_exceeds_rate", "conflict"). Nothing is posted in either case.
   - Review UI: totals panel shows computed vs printed side by side; differences red; Approve disabled with the reason.
     The server check is the real gate - UI is convenience only.
3. Payments made / balance due:
   - Nullable printed_paid_minor, printed_balance_due_minor (same migration), filled from extraction if present,
     shown on review as "Info only - not a payment".
   - Must NOT create a receipt/payment, settlement or allocation, and must NOT change open-item outstanding.
4. Journal preview:
   - GET .../documents/:id/journal-preview returns the Dr/Cr lines (account code+name, VAT code, debit, credit,
     currency, AED) that Approve WOULD post, by reusing buildPostingLines. Read-only: no inserts/updates, no voucher
     number consumed, no audit row.
   - Review screen shows it in a panel before Approve. Totals must balance (sum Dr = sum Cr in AED).
   - Preview and the actual posted journal must match line-for-line for the same document.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "C1-1:".
- Money is integer minor units everywhere (no floats). Follow .cursor/rules/arnibooks.mdc.
- Do not change dual control, RLS policies, periods/locking, or voucher numbering.
- Synthetic data only in tests/fixtures.

TESTS REQUIRED (register new test files in package.json "test"):
- KPI: posted bill overdue + one due in 3 days + one due in 30 days + one DRAFT bill -> totals/overdue/due-7 exact;
  draft excluded. Same for AR on one sales invoice.
- Printed totals: matching printed totals -> approve posts; gross off by 1 fils -> printed_totals_mismatch and no
  journal row created; VAT 60 on net 100 -> vat_exceeds_rate; all printed_* NULL -> approve works as today.
- Payments made: document with printed_paid_minor set -> after approve, open-item outstanding = full gross, no
  receipt/payment/allocation rows.
- Journal preview: preview lines == posted journal lines (account, Dr, Cr, VAT) for the same document; calling preview
  creates no rows anywhere (count journals/vouchers/audit before and after); preview balances.
- e2e: extend e2e/books-phase1.spec.ts minimally: review screen shows the journal preview panel and the totals panel.
  Screenshots only under UPDATE_SCREENSHOTS (existing behaviour) - do not commit docs/phase1/*.png.

ACCEPTANCE CRITERIA:
1. Four features above work as specified; the mismatch/VAT checks are enforced in the server, not only the UI.
2. New migration is additive/idempotent, numbered after 27; earlier migrations untouched.
3. Full npm test: 0 failures, no new skips; e2e gate passes; typecheck passes.
4. No receipt/payment/allocation is created from printed "payments made".
5. Report lists every file changed and maps each test to the requirement it proves.

DO NOT:
- push, force-push, reset, rebase, delete branches
- implement Item/Accounting mode, Approve & Next, party mismatch banner, or the C1 validation matrix (that is C1-2/C1b)
- edit golden expected values, disable/skip/narrow any test, weaken any RLS rule
- commit docs/phase1/*.png, anything under docs/reference/outputs/, or real client data
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If the extraction output has no printed totals at all for uploaded documents, implement the columns + manual entry
  + server check anyway, and say in the report what the extractor would need to emit.
- If enforcing the printed-totals check would break an existing passing test or golden, STOP and explain (owner decides).
- When done, write the report to the path given in the prompt and stop.
