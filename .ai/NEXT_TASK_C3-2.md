TASK ID: C3-2
PHASE: Addendum C / Phase 2 — Match open item + dual-control post

OBJECTIVE:
On Ready bank txns: optional 1:1 open-item match (AR for customer_receipt,
AP for supplier_payment). Approver posts → journal (RV/PY via settlements or
category journal). Dual control: approver ≠ reviewed_by. Status → posted.
No transfer pairs, no N:1 split, no rules engine.

CONSTRAINTS:
- feat/books-phase1. Commit "C3:". No push unless asked.
- Reuse createReceiptOrPayment for matched receipt/payment.
- Money fils integers. Audit all writes.

DO NOT:
- transfer pair detection; bulk post; rules; C4
