TASK ID: C1-2
PHASE: Addendum C - C1 validation matrix (posting rules)

OBJECTIVE:
Make the 8 C1 validation cases from the plan true in the server and prove each one with a test:
correct posting (disbursement 1220, deposit -> asset, exempt, VAT recoverability), "check VAT" flags, approve blocks,
and sales-vs-bill re-routing. UI work (Item/Accounting mode, Approve & Next, party mismatch banner) is NOT in this task.

CONTEXT:
Spec: docs/plan/arnibooks-cursor-prompts-addendum-C.md, "Validation rules to prove with tests" (lines 64-73).
C1-1 (5755744, 02c7976) added printed totals + server checks printed_totals_mismatch / vat_exceeds_rate in
approveAndPostBooksDocument (src/server/books/documents.ts:588). Posting lines come from buildPostingLines
(documents.ts:441): purchase "disbursement" lines already go to 1220; supplier TRN + recoverable VAT code -> 1430.
books_document_lines.line_kind allows revenue, disbursement, taxable_recharge, expense, asset, inventory
(db/23-books-phase1.sql:246-247). Inbox -> draft conversion is in src/server/books/inbox.ts (~lines 330-390);
classification is in worker/src/daftar/extraction/classify.py and books_extractions.doc_type.

FILES TO INSPECT:
- docs/plan/arnibooks-cursor-prompts-addendum-C.md (C1 lines 64-73)
- src/server/books/documents.ts (buildPostingLines, approveAndPostBooksDocument), src/server/books/vat-codes.ts
- src/server/books/inbox.ts, src/server/books/extract-sync.ts (draft creation / doc type routing)
- src/server/books/phase1.test.ts, src/server/books/c1*.test.ts (existing test style; reuse helpers)
- db/20-books-coa-v2.sql (account codes: 1220, 1430, 2210, deposit/asset accounts), db/*vat* seeds (VAT codes)

THE 8 CASES (each = one named test "C1-2 case N: ..."; synthetic parties/amounts only):
1. Bill with mixed lines: gov-fee line with no VAT -> disbursement 1220; service lines at 5% -> expense + 1430 input VAT.
2. Gov-authority bill with no VAT at all -> all lines disbursement (1220), no 1430 line.
3. Supplier HAS a TRN but a service line has no VAT -> document gets a "check_vat" flag/warning (stored, visible via
   the document API); it is NOT silently accepted. Decide: approve allowed only after the flag is acknowledged
   (store who/when, audited). Do not block forever.
4. Foreign-currency bill, supplier has no TRN -> recoverable VAT = 0 (no 1430 line; VAT goes to cost);
   a "refundable security deposit" line with line_kind 'asset' -> asset/deposit account, not expense.
5. Sales invoice in USD with "- Arnifi Fee" (5%) and "- Government Fee" (no VAT) lines -> revenue + 2210 output VAT
   for the fee, Cr 1220 for the gov fee; AED amounts via the document FX rate, integer minor units.
6. Exempt residential lease invoice -> exempt VAT code, no 2210 output VAT line.
7. Document classified as a sales invoice but uploaded under Purchases -> becomes a sales_invoice draft (moved to
   Sales with a notice/audit row), never a purchase_bill; it is never posted as a purchase.
8. VAT > 5% of taxable (e.g. tax larger than subtotal) -> vat_exceeds_rate, approve blocked, nothing posted
   (C1-1 already has the check - prove it for a multi-line document and keep one assertion that no journal exists).

IMPLEMENTATION REQUIREMENTS:
- Fix whatever the tests show is wrong in buildPostingLines / draft creation. Keep changes minimal and in the server.
- If a deposit/asset account code is missing from the COA seed, add it in a NEW migration (next free number after 28,
  additive/idempotent), not by editing older files.
- check_vat flag (case 3): store on the document (new nullable columns in the same migration, e.g. check_vat_reason,
  check_vat_ack_by, check_vat_ack_at) + POST .../documents/:id/ack-check-vat (audited). Approve without ack ->
  BooksError("check_vat_unacknowledged", "conflict"). Show the flag + Acknowledge button on the review screen
  (minimal UI only).
- Every journal produced by the tests must balance in AED (sum Dr = sum Cr).

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "C1-2:".
- Integer minor units only. Follow .cursor/rules/arnibooks.mdc.
- Tests must only measure rows they create (tests run in parallel against shared synthetic companies - see
  02c7976 for the pattern: own party per test, document-scoped counts).
- Do not change dual control, RLS policies, period locking, voucher numbering, or C1-1 printed-total behaviour.

TESTS REQUIRED:
- New file src/server/books/c1-validation.test.ts with the 8 named tests above, registered in package.json "test".
- Each posting test asserts the exact journal lines (account code, Dr, Cr, VAT code) - not just "it posted".
- Full npm test 0 failures; e2e gate passes; typecheck passes.

ACCEPTANCE CRITERIA:
1. All 8 case tests exist, are named "C1-2 case N: ...", and pass in the orchestrator's unit gate.
2. Exact journal lines asserted for cases 1, 2, 4, 5, 6.
3. check_vat flag requires an audited acknowledgement before approve; case 7 never creates a purchase_bill.
4. Any new migration is additive/idempotent and numbered after 28; earlier migrations untouched.
5. No golden values edited; no test skipped, narrowed or loosened; existing tests unchanged except new helpers.
6. Report maps each case to its test and lists every file changed.

DO NOT:
- push, force-push, reset, rebase, delete branches
- implement Item/Accounting mode, Approve & Next, party mismatch banner (C1-3)
- edit golden expected values, disable/skip/narrow any test, weaken any RLS rule
- commit docs/phase1/*.png, anything under docs/reference/outputs/, or real client data
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If a case conflicts with an existing golden or passing test (e.g. the PROVISIONAL Company A golden), STOP and explain
  in the report - the owner decides the accounting treatment.
- If the correct VAT treatment for a case is genuinely ambiguous under UAE VAT, implement the plan's wording, and
  list the question in the report.
- When done, write the report to the path given in the prompt and stop.
