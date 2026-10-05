# Review - C1-2-fix1 iteration 1

**Decision: PASS**

The fix does what the task asked. A bill uploaded under Purchases now moves to Sales only when the document is actually classified as 'sales_invoice'. Unknown (blank), 'receipt' and 'purchase_bill' classifications now stay as purchase bills, with no re-route audit row. In src/server/books/inbox.ts the re-route check now uses a new exact-match flag, isSalesInvoice (detected.toLowerCase() === 'sales_invoice'), instead of the old catch-all classifier. The removed `else if (!intended) docType = classified` branch did nothing extra, because `docType = intended || classified` already covers that case. So when the user gives no type, the existing classification-based fallback behaves exactly as before. Three new tests (7b, 7c, 7d) build their own synthetic supplier, inbox item and extraction, and check the returned docType, reroutedFrom, the stored books_documents.doc_type and that there are zero reroute_doc_type audit rows. All three passed in the orchestrator's unit run (112 tests, 111 pass, 0 fail, 1 skip). The only skip is the existing PROVISIONAL Company A golden. The existing case 7 test is unchanged and still passes. Only the two allowed files changed. Typecheck is green. The e2e gate was not run because no UI, e2e or db files changed.

- [PASS] 1. Tests 7b, 7c, 7d exist with exact names and pass in orchestrator unit gate (not skipped) - c1-validation.test.ts adds the three tests with the exact names; gates/unit.log ok 31/32/33, durations ~85-93ms (DB-backed, not the early `if (!admin) return` path)
- [PASS] 2. Existing 'C1-2 case 7' passes unchanged - diff only inserts new code after case 7 (hunk @@ -494); gates/unit.log ok 30 - C1-2 case 7
- [PASS] 3. Re-route only on exact 'sales_invoice' classification (code inspection) - src/server/books/inbox.ts:370 isSalesInvoice = detected.toLowerCase() === 'sales_invoice'; inbox.ts:391-397 re-route condition uses isSalesInvoice; inbox.ts:388 fallback `intended || classified` unchanged for the no-intent case; the removed else-if is provably redundant
- [PASS] 4. Only inbox.ts and c1-validation.test.ts changed - git diff --stat 8045b92..484e04f: 2 files (c1-validation.test.ts +136, inbox.ts +3/-3); package.md shows no forbidden files
- [PASS] 5. No test skipped/narrowed/loosened; no golden edited - diff is additive in the test file; unit.log skipped 1 = existing PROVISIONAL Company A golden; Desert Falcon Jun TB golden passes (ok 69)
- [PASS] 6. Report lists files changed and maps 7b/7c/7d to tests - cursor-report.md 'Files changed' table and 'Tests — map 7b/7c/7d' table

Needs human validation: 

Question: 
