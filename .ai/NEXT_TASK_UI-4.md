TASK ID: UI-4
PHASE: UI polish 4 of 4 - statement review layout (reference: docs/reference/tofu/UI-PATTERNS.md section 5)

OBJECTIVE:
Statement review reads like a bank statement: one header per account with a balanced badge, opening -> closing on one
line, read-first rows, account/currency filters when a statement has several accounts.

CONTEXT:
- src/app/books/statements/[id]/page.tsx: native select for the statement, opening/closing inputs, formula text
  "Opening + sum(cr) - sum(dr) = ... OK", dates/descriptions as always-on inputs, RB check column (rb-check-N),
  dev sentence "Phase 1 staging - bank matching consumes these in Phase 2.".
- E2 stores one statement per IBAN with lines and a balance check; ambiguous multi-IBAN -> two statements flagged
  account_attribution_ambiguous.
- Plan: .ai/ui-polish-plan.md (guardrails apply).

FILES TO INSPECT:
- src/app/books/statements/[id]/page.tsx, src/app/books/statements/page.tsx, src/lib/statement-line.ts,
  src/lib/iban.ts, src/components/books/data-grid.tsx, e2e/books-phase1.spec.ts

IMPLEMENTATION REQUIREMENTS:
1. Account header row: bank name . masked IBAN (AE07 **** 3456 via src/lib/iban.ts) . currency . period dd/mm/yyyy .
   badge "Balanced" (green) or "Off by X.XX" (red) from the existing check . collapse toggle.
   Ambiguous attribution flag shown as a warning badge with a tooltip.
2. "Opening 1,000.00 -> Closing 1,300.00" on one line; the formula moves into a Tooltip. Keep
   statement-balance-status testid on the badge.
3. Rows read-first (text), click to edit, same save/re-check handlers. Debit/Credit right-aligned, blank when zero,
   never both filled. Running-balance check as an icon column with tooltip; keep rb-check-N testids.
4. When the uploaded file produced more than one statement: "All accounts" / "All currencies" Selects above the
   list filter which account sections show.
5. Replace the native statement select with the shadcn Select; keep its testid.
6. Remove the "Phase 1 staging ..." sentence. No Account / VAT columns (that is C3, Phase 2).

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "UI-4:".
- UI only. No db/, worker/, src/server/, API changes; no new dependencies; no journal posting or matching.
- Keep all existing data-testids; RTL-safe; theme tokens only.

TESTS REQUIRED:
- e2e: open the bank_a fixture statement -> header shows masked IBAN, currency and "Balanced"; edit one amount ->
  badge switches to "Off by" and back after undo; rb-check testids still present.
- Unit: masked IBAN helper (if added) and "Off by" amount formatting from fils.
- Full npm test 0 failures; typecheck; e2e green. Screenshots only under UPDATE_SCREENSHOTS.

ACCEPTANCE CRITERIA:
1. Header per account with balanced/off-by badge (e2e proves both states).
2. No native <select> and no "Phase 1 staging" text on the page.
3. Existing statement e2e still pass. No test skipped/narrowed.

DO NOT:
- push, force-push, reset, rebase, delete branches
- add categorisation, accounts, VAT, matching or posting
- change the balance-check logic (display only)
- commit docs/phase1/*.png or scratch files; run `git add -A` blindly

STOP CONDITIONS:
- If the page needs data the API does not return (e.g. bank name), show what exists and list the gap in the report.
- When done, write the report to the path given in the prompt and stop.
