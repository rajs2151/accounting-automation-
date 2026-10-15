TASK ID: C3-3
PHASE: Addendum C / Phase 2 — Transfer pairs → one Contra (CV)

OBJECTIVE:
When two books_bank_transactions are own-account transfers (out on A, in on B),
accountant links them as a pair; both Ready; approver posts once → one Contra
(CV) via createContra; both rows → posted with the same journal_entry_id.
Dual control: approver ≠ reviewed_by (either side’s reviewer if same; if both
reviewed by same preparer, that preparer cannot post).

CONSTRAINTS:
- feat/books-phase1. Commit "C3:". No push unless asked.
- Reuse createContra(preparer, approver, …) from settlements.ts.
- Money fils integers. Same currency + equal absolute amounts required.
- Manual link only (picker). No auto-detect across statements yet.
- New columns on books_bank_transactions only (db/37).

SCHEMA (db/37):
- transfer_pair_id uuid NULL — shared id for the two rows (or linked_txn_id
  uuid REFERENCES books_bank_transactions(id) UNIQUE pair constraint).
  Prefer: linked_txn_id uuid NULL REFERENCES books_bank_transactions(id)
  with CHECK that both point at each other (enforced in app) OR a pair table.
  Thin choice: `transfer_link_id uuid` same value on both rows + unique partial
  index so a txn appears in at most one open pair.

SERVER:
- linkTransferPair(actor, clientId, txnId, counterpartTxnId)
  - both txn_type=transfer, opposite direction (one debit>0, one credit>0),
    same currency, equal amount, different account_id, same client,
    status needs_review|ready, neither posted/excluded, neither already linked.
  - set transfer_link_id on both; audit.
- unlinkTransferPair (if either still not posted).
- postBooksBankTransaction: if txn_type=transfer, require link + counterpart
  ready; call createContra once; mark BOTH posted with same journal_entry_id.
  Category account not required for transfers.
- markReviewed for transfer: require link present (or allow Ready without link
  but block post — prefer block post only to keep categorize flow simple).

API:
- POST .../bank-transactions/:id/transfer-link { counterpartId }
- DELETE .../bank-transactions/:id/transfer-link
- Existing post endpoint posts the pair when either id is posted.

UI (/books/transactions):
- Type=Transfer: Match column becomes “Link account…” counterpart picker
  (other accounts’ unmatched transfer rows, filtered by amount/currency).
- Show linked counterpart summary; Post on either Ready row posts the pair.
- No bulk, no auto-suggest beyond amount+currency filter.

TESTS:
- Unit: link → mark both Ready → Omar cannot post if he reviewed → Layla posts
  → one CV, both review_status=posted, same journal_entry_id, no allocations.
- Reject: same account, amount mismatch, wrong direction, already linked.
- Gates: unit + typecheck + pytest + e2e (existing smoke still passes).

DO NOT:
- auto-detect pairs; N:1 splits; bank fees/FX on transfers; bulk post; rules; C4
