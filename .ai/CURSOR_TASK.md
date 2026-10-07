TASK ID: P5-1
PHASE: Phase 5 - Month-end close: close checklist + lock gate (server + screen)

OBJECTIVE:
A close checklist per company x period that computes each gate from existing data, and a Lock action (approver)
that only succeeds when every gate passes or is waived with a reason (audited). Unlock needs a reason (audited);
posting into a period after it was unlocked marks that period "changed since close".

READ FIRST: .ai/HOW_TO_WORK.md; spec docs/plan/arnibooks-cursor-prompts.md lines 325-350 (Phase 5 section 1).
PORT, don't invent: the legacy close engine src/server/close.ts (closeChecklist, waive*ForClose, closePeriod,
reopenPeriod, listCloseEvents) works on old tables - reuse its structure for the books module.

EXISTING (books): src/server/books/periods.ts (lockBooksPeriod, reopenBooksPeriod); bank-recon.ts (ledger vs
statement per account/month); dashboard.ts (statement coverage, review counts, issues); bank-transactions.ts
(review_status needs_review/ready/posted/excluded); place-of-supply.ts gap list; vat201.ts draft; schedule-post
(P4-4 scheduled/recurring entries). COA: 1390 Suspense; clearing 1130, 1220, 1300, 1310, 1320, 1330, 1340;
VAT 2210 output / 1430 input.

GATES (each: status pass | fail | waived, a count, and a deep link):
1. Statements: every bank/card/gateway account has statement coverage for the whole period (reuse dashboard logic).
2. Bank lines: no bank txn in the period still needs_review or ready-not-posted.
3. Bank reconciliation: bank-recon difference = 0 for every bank account at period end.
4. Suspense 1390 closing balance = 0 (else list the entries).
5. Clearing accounts: 1310/1320/1330 (gateway/POS) and 1340 (transfers) net to 0 at period end; 1220
   (disbursements) and 1300/1130 shown as information with their balance (no auto-fail; owner decides later).
6. Scheduled/recurring entries due in the period are posted.
7. VAT control: VAT 201 draft (if the stagger period ends this month) has no place-of-supply gaps, and its Box 8/11
   VAT ties to the 2210/1430 movement; otherwise "not a VAT period end" = pass.
8. Missing documents: bank lines posted by category (no invoice/bill) above a threshold are listed (information only).
Depreciation and FX revaluation gates are added by P5-2 and P5-3 - leave a placeholder that reports "not set up".

SERVER: new src/server/books/close.ts: getBooksCloseChecklist(userId, clientId, periodId), waiveBooksCloseGate
(approver/admin, reason required, audited), lockBooksPeriodWithChecklist (approver/admin; refuses with
close_gates_failing + the failing gates), unlock = existing reopenBooksPeriod but reason required + audited; a
"changed since close" flag set when any journal is posted into a reopened period. New migration for waivers/close
events/flag (books tables, RLS like other books tables).
SCREEN: src/app/books/close/page.tsx (period picker from the top bar): gate list with status badges, counts, deep
links, Waive (reason) and Lock buttons (approver only; UI mirrors server), close history.
Add "Close" to the Books nav (append-only change in the nav list).

TESTS: unit for each gate pass/fail with test-owned data (createTestCompany); lock refused while a gate fails;
waive with reason then lock succeeds; accountant cannot lock/waive (403); unlock requires reason; posting after
unlock sets "changed since close". e2e: open Close page, see gates, lock as approver.

ACCEPTANCE: gates computed server-side; lock/waive/unlock rules enforced server-side and audited; tests above pass;
full gates green.
DO NOT: edit bank-transactions.ts/settlements.ts logic (read only), change dual control, delete periods.
