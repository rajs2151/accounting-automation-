TASK ID: E1d
PHASE: Extraction fix - never invent VAT code SR on confirm / UI

OBJECTIVE:
When a line has no printed VAT evidence (worker vat_code null + flag vat_code_missing), confirm and the review
UI must not silently fill in SR. Accountants see missing VAT as missing, not as 5% standard.

CONTEXT:
- E1c (worker) now emits vat_code only from document evidence (SR / ZR / EX / OOS) or null + vat_code_missing.
  It never defaults to SR.
- Observed SR on Tax Exempt invoices came from the *server/UI* fallbacks, not the worker:
  1. src/server/books/inbox.ts confirmInboxAsDocument: `vatCode: l.vatCode || "SR"` and empty-lines fallback
     `vatCode: "SR"`.
  2. src/app/books/inbox/[id]/page.tsx normalizeLines: `vatCode: l.vatCode || "SR"`.
  3. Manual create forms on sales/purchases pages also default new lines to SR (acceptable for *manual* entry
     when the accountant picks a code; do not change those unless the owner asks).

FILES TO INSPECT:
- src/server/books/inbox.ts (confirmInboxAsDocument)
- src/app/books/inbox/[id]/page.tsx (normalizeLines)
- src/server/books/documents.ts (any taxable_recharge SR fallback — report only if it invents on confirm path)
- e2e/books-phase1.spec.ts, unit tests that assume confirm always posts SR

IMPLEMENTATION REQUIREMENTS:
1. confirmInboxAsDocument: if line vatCode is null/undefined/empty, keep it null (or reject confirm with a clear
   validation error listing lines that need a VAT code). Do NOT coerce to "SR".
2. Review UI normalizeLines: do not substitute "SR" for missing codes; show blank / "—" and require the accountant
   to pick a code before Confirm succeeds (same gate as other missing fields).
3. Keep existing data-testids. Dual control / approve path unchanged aside from not inventing VAT.
4. Unit or e2e: worker-shaped extraction with vat_code null + vat_code_missing does not become SR after confirm
   (or Confirm is blocked until a code is chosen — pick one behaviour and document it in the report).

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "E1d:".
- Touch only the confirm/review VAT fallback paths listed above. No worker changes (E1c owns those).
- No new dependencies. No real client data.

TESTS REQUIRED:
- Unit or e2e proving null vatCode is preserved or confirm blocked (not silently SR).
- Full npm test 0 failures; typecheck; e2e green.

ACCEPTANCE CRITERIA:
1. No confirm path invents SR when the extraction had no VAT evidence.
2. Existing balanced SR fixtures still confirm/post as today.
3. No test skipped/narrowed.

DO NOT:
- push, force-push, reset, rebase, delete branches
- re-introduce a hard-coded SR default on the confirm path
- change dual control, RLS, or posting immutability rules
- commit docs/phase1/*.png or scratch files; run `git add -A` blindly

STOP CONDITIONS:
- If product policy requires "block confirm" vs "allow null through to documents", STOP and ask the owner.
- When done, write the report to the path given in the prompt and stop.
