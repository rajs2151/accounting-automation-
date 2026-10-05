TASK ID: C1-2-fix1
PHASE: Addendum C - C1 validation matrix (case 7 re-route correctness)

OBJECTIVE:
Re-route a Purchases upload to Sales ONLY when the document is actually classified as a sales invoice. Unknown, empty, receipt or any other non-sales classification must keep the user's intended or explicit purchase_bill type.

CONTEXT:
C1-2 (39b7bfc) added classifyInboxDocType() and re-route logic in src/server/books/inbox.ts confirmInboxAsDocument. classifyInboxDocType returns 'sales_invoice' for everything not containing 'purchase'/'bill'/'debit_note', including '' or null (worker classify.py returns doc_type None on no_rule_match), 'receipt', 'bank_statement', etc. The reroute condition `(intended === 'purchase_bill' || body.docType === 'purchase_bill') && classified === 'sales_invoice'` therefore moves unclassified supplier bills to Sales. The spec (addendum-C C1, case 7) only covers 'classified as a sales invoice'.

FILES TO INSPECT:
- src/server/books/inbox.ts (classifyInboxDocType, confirmInboxAsDocument)
- src/server/books/c1-validation.test.ts (case 7 setup pattern: own customer/supplier, admin inserts into books_files / books_inbox_items / books_extractions)
- worker/src/daftar/extraction/classify.py (DOC_TYPES; read-only, do not change)

EXPECTED BEHAVIOR:
- Re-route to sales_invoice (with reroutedFrom='purchase_bill', notice, and 'reroute_doc_type' audit) ONLY when the normalised detected type (review.detectedType || review.extractionDocType) is exactly 'sales_invoice' AND the intended/explicit type is purchase_bill.
- If intended/explicit type is purchase_bill and detected is '', null, 'receipt', 'purchase_bill', 'debit_note' or any other value → docType stays 'purchase_bill', reroutedFrom null, no reroute audit row.
- If intended/explicit type is sales_invoice → stays sales_invoice (unchanged from current behaviour).
- With no intended and no explicit type, keep today's fallback (classification-based) unchanged.

IMPLEMENTATION REQUIREMENTS:
- Minimal change in src/server/books/inbox.ts only. Separate 'is the document positively classified as sales' (exact match) from the existing fallback mapping; do not change the fallback for the no-intent case.
- Remove the dead `else if (!intended) docType = classified;` branch if it becomes redundant; behaviour must stay as above.

CONSTRAINTS:
- Work on feat/books-phase1; local commit with prefix 'C1-2-fix1:'. Stage only the files you change.
- Tests use their own synthetic parties and only count rows they create (pattern from 02c7976 / case 7).
- Do not change dual control, RLS, period locking, voucher numbering, C1-1 printed totals, check_vat, or buildPostingLines.

TESTS REQUIRED (add to src/server/books/c1-validation.test.ts; existing 8 cases unchanged):
- 'C1-2 case 7b: unknown classification under Purchases stays purchase_bill': inbox intended_type='purchase_bill', detected_type NULL and extraction doc_type NULL (or 'unknown' if the column is NOT NULL), confirm with docType 'purchase_bill' → confirmed.docType === 'purchase_bill', reroutedFrom === null, books_documents.doc_type === 'purchase_bill', zero 'reroute_doc_type' audit rows for that document.
- 'C1-2 case 7c: receipt classification under Purchases stays purchase_bill': same with detected_type/doc_type 'receipt'.
- 'C1-2 case 7d: purchase_bill classification under Purchases stays purchase_bill': detected 'purchase_bill'.
- Full npm test: 0 failures; e2e gate passes; typecheck passes.

ACCEPTANCE CRITERIA:
1. Tests 7b, 7c, 7d exist with those names and pass in the orchestrator unit gate (not skipped).
2. Existing 'C1-2 case 7' still passes unchanged: sales_invoice classification under Purchases → sales_invoice draft + reroute_doc_type audit.
3. Re-route happens only on exact 'sales_invoice' classification; verified by code inspection of inbox.ts.
4. No other files changed except inbox.ts and c1-validation.test.ts (plus the report).
5. No test skipped, narrowed or loosened; no golden values edited.
6. Report lists files changed and maps 7b/7c/7d to tests.

DO NOT:
- push, force-push, reset, rebase, delete branches
- edit golden expected values, disable/skip/narrow any test, weaken RLS
- change worker/src/daftar/extraction/classify.py or buildPostingLines
- commit docs/phase1/*.png, anything under docs/reference/outputs/, or real client data
- run `git add -A` blindly

STOP CONDITIONS:
- If books_inbox_items.detected_type or books_extractions.doc_type cannot hold NULL/'receipt' under current constraints, use the closest allowed non-sales value and explain in the report.
- If fixing this breaks an existing test, STOP and report; do not modify that test.
- When done, write the report to the path given in the prompt and stop.
