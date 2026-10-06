TASK ID: C2-1
PHASE: Addendum C — Bank accounts page (coverage / gaps)

OBJECTIVE:
Add a Banking page listing COA bank/card/gateway/cash accounts with statement
coverage, gaps, last closing, ledger balance, unreviewed count, and Upload
(blocked until account is set up). Extraction/matching stay as today (E4 statements
list + Phase 2 matching later).

CONTEXT:
- Statements staging exists at /books/statements (file-centric, no COA link).
- books_accounts has is_bank + sub_type; no is_card/is_gateway/iban yet.
- books_statement_extractions has iban/period/balances but no account_id.

FILES:
- db/33-books-c2-bank-accounts.sql
- src/lib/statement-coverage.ts (+ test)
- src/server/books/bank-accounts.ts (+ test)
- src/app/books/banking/page.tsx
- src/app/api/books/[...path]/route.ts
- src/components/shell.tsx (Banking nav)
- e2e/books-phase1.spec.ts (smoke)

IMPLEMENTATION:
1. SQL: is_card, is_gateway, bank_name, iban, iban_last4 on books_accounts;
   account_id on books_statement_extractions; backfill flags from sub_type.
2. Soft-link statements→accounts by account_id OR normalised IBAN match.
3. Coverage helper: merged period + day gaps between sorted statements.
4. listBooksBankAccounts: type, setupOk, coverage, gaps, lastClosing, ledgerBalance,
   difference, unreviewedLineCount.
5. PATCH bank-accounts/:id for bank_name/iban/iban_last4 (audited).
6. UI /books/banking with Not set up (red) blocking row Upload; header Upload still
   goes to generic statement upload (existing inbox API).
7. Nav: Banking → /books/banking (before Transactions).

CONSTRAINTS:
- feat/books-phase1. Commit "C2:". No push. No Phase 2 matching/posting.
- No ground_truth/golden edits. Synthetic only.

TESTS:
- Unit: coverage gaps; listBooksBankAccounts shape / Not set up.
- e2e: Banking heading + table visible.
- Full gates.

DO NOT:
- rebuild statement extraction; post bank lines; force-push
