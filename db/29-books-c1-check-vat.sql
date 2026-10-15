-- C1-2: check_vat flag + acknowledgement on books_documents; inbox intended_type for upload context.
-- Additive and idempotent. Does not alter posted data or RLS.
-- Deposit account 1420 already exists in db/20-books-coa-v2.sql.

ALTER TABLE books_documents
  ADD COLUMN IF NOT EXISTS check_vat_reason text,
  ADD COLUMN IF NOT EXISTS check_vat_ack_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS check_vat_ack_at timestamptz;

COMMENT ON COLUMN books_documents.check_vat_reason IS
  'Non-null when a service/expense line has no VAT despite supplier TRN; Approve blocked until acknowledged.';
COMMENT ON COLUMN books_documents.check_vat_ack_by IS
  'User who acknowledged the check_vat warning (audited).';
COMMENT ON COLUMN books_documents.check_vat_ack_at IS
  'UTC timestamp when check_vat was acknowledged.';

ALTER TABLE books_inbox_items
  ADD COLUMN IF NOT EXISTS intended_type text;

COMMENT ON COLUMN books_inbox_items.intended_type IS
  'Upload context: purchase_bill (Purchases) or sales_invoice (Sales). Classification may re-route.';
