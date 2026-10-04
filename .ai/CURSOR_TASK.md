TASK ID: C1-1-fix1
PHASE: Addendum C - C1 Purchases/Sales review queue (part 1 of 2), corrective

OBJECTIVE:
Make the C1-1 unit tests deterministic so the required unit gate is green. The orchestrator re-ran npm test: 98 pass / 2 fail. Both failures are C1-1 tests that check company-wide totals/counts on the shared synthetic company DESERT while other test files post to it at the same time. Do not change product behaviour unless a test proves a real bug.

CONTEXT:
- gates/unit.log: 'C1-1 KPI: AP outstanding / overdue / due-7; draft excluded' failed at src/server/books/c1-money-checks.test.ts:128 (total-outstanding delta 73500 !== 63000; the extra 10500 came from another test file posting an AP bill to DESERT at the same time).
- 'C1-1 journal preview: matches posted lines; creates no rows; balances' failed at :350 (audit count 105 → 106 for all of DESERT; previewBooksDocumentJournal itself only does SELECTs).
- The voucher check counts books_voucher_sequences rows; consuming a voucher number updates last_no and adds no row, so the check cannot detect a consumed number.
- Your report claimed '100 pass, 0 fail'. Report the orchestrator-equivalent full `npm test` result truthfully.

FILES TO INSPECT:
- src/server/books/c1-money-checks.test.ts
- src/server/books/open-items.ts (getBooksOpenItemKpis)
- src/server/books/documents.ts (previewBooksDocumentJournal)
- src/components/books/open-item-kpis.tsx
- books_voucher_sequences / books_audit_events / books_journal_entries schema in db/

EXPECTED BEHAVIOR:
- The KPI test proves exact totals for ONLY the rows it creates, no matter what other test files do at the same time.
- The preview test proves that preview writes nothing, using checks scoped to this test's document, plus a voucher check on the last-used number.

IMPLEMENTATION REQUIREMENTS:
1. KPI isolation. Pick one:
   (a) In the test, create a new synthetic supplier (and customer for AR) with a unique name/tag in DESERT. Add an optional `partyId` filter to getBooksOpenItemKpis (server function + `partyId` query param on GET open-items/kpis, still posted open items only) and assert EXACT values (not deltas): AP total 63000, overdue 10500, due-7 21000, draft excluded; AR overdue 42000, due-7 52500, total 94500.
   (b) Or compute the KPI with the same function scoped to the test's party.
   Do not just retry, loosen the assertions, or check '>='.
2. Preview isolation:
   - Audit: count books_audit_events WHERE client_id = DESERT AND entity_id = the test document id (and any audit row whose entity is the document's lines or journal) before and after preview → equal.
   - Journals: count books_journal_entries linked to this document (journal_entry_id on books_documents stays NULL, and no journal entry references this document) before and after preview → unchanged.
   - Vouchers: snapshot (id, fiscal year, prefix, last_no or equivalent column) of every books_voucher_sequences row for DESERT before and after preview → deepEqual. Fix the assertion so it catches a consumed number.
   - Then approve and assert preview lines == posted lines (account code, VAT code, Dr, Cr) as now, and that sum Dr = sum Cr in AED.
3. Apply the same scoping to the 'payments made' test: count allocations and receipt/payment documents for the test's own party/document only, not all of DESERT.
4. KPI tiles: while loading or on fetch error, show '…' or '—' (not 0.00); keep the exact-value title only when real data has loaded.
5. Remove the dead debitAed/creditAed `void` code in previewBooksDocumentJournal; if `balanced` should use AED, compute it from AED amounts and keep the test proving it.

CONSTRAINTS:
- feat/books-phase1, local commit, message prefix "C1-1-fix1:".
- Integer minor units only; synthetic data only; follow .cursor/rules/arnibooks.mdc.
- Do not change dual control, RLS, periods/locking, voucher numbering, or the printed-totals / VAT gate logic.
- Do not change the test runner concurrency or package.json test flags to hide the race.

TESTS REQUIRED:
- Updated src/server/books/c1-money-checks.test.ts as above (still registered in package.json "test").
- If partyId was added to the KPI function: one assertion that a document from a different party is excluded.
- Run the full `npm test` 3 times in a row on a fresh migrated DB; all three must show 0 failures. Paste the three '# tests/# pass/# fail/# skipped' summaries in the report.

ACCEPTANCE CRITERIA:
1. Full npm test: 0 failures, the only skip is the pre-existing PROVISIONAL golden, across 3 consecutive runs (summaries in report).
2. The KPI tests assert exact AP (63000 / 10500 / 21000) and AR (94500 / 42000 / 52500) values scoped to test-owned data; draft excluded.
3. The preview test asserts no audit, journal or voucher change, using document-scoped audit/journal checks and a last-used-number snapshot of voucher sequences; preview == posted line-for-line; balanced in AED.
4. The payments-made test is scoped to its own party/document and still proves no allocation/receipt/payment and outstanding = full gross.
5. KPI tiles never show 0.00 for unloaded or failed data.
6. e2e gate and typecheck still pass.
7. Report lists every changed file and maps each test to the criterion it proves; no claims the logs don't show.

DO NOT:
- push, force-push, reset, rebase, delete branches
- edit golden expected values; disable, skip, .todo, or narrow any test; add retries; loosen to >= / approximate checks
- change test concurrency flags or remove other test files from npm test
- weaken any RLS rule or change dual control / voucher numbering / period locking
- commit docs/phase1/*.png, anything under docs/reference/outputs/, or any real client data
- run `git add -A` blindly; stage only files for this task
- implement C1-2 / C1b scope (Item/Accounting mode, Approve & Next, party mismatch banner, validation matrix)

STOP CONDITIONS:
- If, after scoping, the preview test still shows a write caused by previewBooksDocumentJournal itself, STOP and report the exact row and code path (it would be a real bug).
- If adding partyId to the KPI function would change existing API behaviour for callers that don't pass it, STOP and explain.
- When done, write the report to the path given in the prompt and stop.
