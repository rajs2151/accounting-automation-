TASK ID: C3-1
PHASE: Addendum C / Phase 2 — Bank transactions (categorize, no post)

OBJECTIVE:
Materialize eligible statement lines into books_bank_transactions. Ship
/books/transactions with Needs Review | Ready | Excluded tabs; Type + COA
account; Mark reviewed / Exclude. No AR/AP match, no journal post.

CONSTRAINTS:
- feat/books-phase1. Commit "C3:". No push unless asked.
- New books_* table only — never write Stage C bank_transactions.
- Money = fils integers. Dual control not required for mark/exclude.

DO NOT:
- post journals; open-item match; rules engine; C4 dashboard
