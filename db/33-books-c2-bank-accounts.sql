-- C2-1: Bank / card / gateway setup fields + statement → COA link.

ALTER TABLE books_accounts
  ADD COLUMN IF NOT EXISTS is_card boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_gateway boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS iban text,
  ADD COLUMN IF NOT EXISTS iban_last4 text;

COMMENT ON COLUMN books_accounts.is_card IS 'C2: credit-card payable / card instrument';
COMMENT ON COLUMN books_accounts.is_gateway IS 'C2: payment gateway clearing (Stripe etc.)';
COMMENT ON COLUMN books_accounts.iban IS 'C2: full IBAN for statement matching (synthetic only in FAIL gate)';
COMMENT ON COLUMN books_accounts.iban_last4 IS 'C2: last 4 of IBAN/card for display';

-- Backfill instrument flags from COA v2 sub_type (idempotent).
UPDATE books_accounts SET is_card = true
 WHERE COALESCE(sub_type, '') = 'card' AND is_card = false;

UPDATE books_accounts SET is_gateway = true
 WHERE COALESCE(sub_type, '') IN ('gateway', 'clearing') AND is_gateway = false;

UPDATE books_accounts SET is_bank = true
 WHERE COALESCE(sub_type, '') IN ('bank', 'cash') AND is_bank = false;

ALTER TABLE books_statement_extractions
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES books_accounts(id);

CREATE INDEX IF NOT EXISTS books_statement_extractions_account_idx
  ON books_statement_extractions (client_id, account_id)
  WHERE account_id IS NOT NULL;

COMMENT ON COLUMN books_statement_extractions.account_id IS
  'C2: COA bank/card/gateway account; may be null until linked by IBAN or accountant';
