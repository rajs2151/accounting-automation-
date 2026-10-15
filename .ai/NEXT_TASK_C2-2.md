TASK ID: C2-2
PHASE: Addendum C — Statement upload attribution + sample CSV + logs

OBJECTIVE:
When uploading a statement to a Banking row, persist the intended COA account.
After extract, if the file IBAN ≠ that account’s IBAN → needs_review +
`iban_account_mismatch` and do not link `account_id` to the wrong account
(still soft-link by extracted IBAN when it matches another account). Provide
“Download sample sheet” CSV and a Statement logs view (uploader, time, extractor
version, errors/flags).

CONTEXT:
- C2-1 Banking page sends `accountId` on upload but API ignores it.
- `books_statement_extractions.account_id` exists; worker does not set it yet.
- Soft-link by IBAN already exists in listBooksBankAccounts / setup PATCH.

FILES:
- db/34-books-c2-intended-account.sql
- src/lib/statement-account-link.ts (+ test)
- src/server/books/inbox.ts (accountId on upload)
- src/app/api/books/[...path]/route.ts
- worker extraction (set account_id + mismatch flag)
- public/samples/bank-statement-sample.csv
- src/server/books/statement-extractions.ts (logs)
- Banking + Statements UI
- .ai/STATUS.md

CONSTRAINTS:
- feat/books-phase1. Commit "C2:". No push. No Phase 2 matching.
- Never auto-link mismatched intended account. Synthetic only.

TESTS:
- Unit: resolveStatementAccountLink match / mismatch / missing / no-intended.
- Worker or unit: extract path sets flag (prefer pure helper + worker smoke if cheap).
- Full gates.

DO NOT:
- invent VAT; rebuild extraction parsers; push
