-- C1-1: printed totals / payments-made on books_documents (info + approve gates).
-- Additive and idempotent. Does not alter posted data or RLS.

ALTER TABLE books_documents
  ADD COLUMN IF NOT EXISTS printed_net_minor bigint,
  ADD COLUMN IF NOT EXISTS printed_vat_minor bigint,
  ADD COLUMN IF NOT EXISTS printed_gross_minor bigint,
  ADD COLUMN IF NOT EXISTS printed_paid_minor bigint,
  ADD COLUMN IF NOT EXISTS printed_balance_due_minor bigint;

COMMENT ON COLUMN books_documents.printed_net_minor IS
  'Document-currency net as printed/extracted; NULL = not provided. Approve blocked if set and ≠ computed.';
COMMENT ON COLUMN books_documents.printed_vat_minor IS
  'Document-currency VAT as printed/extracted; NULL = not provided.';
COMMENT ON COLUMN books_documents.printed_gross_minor IS
  'Document-currency gross as printed/extracted; NULL = not provided.';
COMMENT ON COLUMN books_documents.printed_paid_minor IS
  'Info only — amount shown as already paid on the document. Never creates a settlement.';
COMMENT ON COLUMN books_documents.printed_balance_due_minor IS
  'Info only — balance due printed on the document. Never changes open-item outstanding.';
