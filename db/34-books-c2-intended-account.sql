-- C2-2: intended COA account on statement upload (row Upload from Banking).

ALTER TABLE books_inbox_items
  ADD COLUMN IF NOT EXISTS intended_account_id uuid REFERENCES books_accounts(id);

CREATE INDEX IF NOT EXISTS books_inbox_intended_account_idx
  ON books_inbox_items (client_id, intended_account_id)
  WHERE intended_account_id IS NOT NULL;

COMMENT ON COLUMN books_inbox_items.intended_account_id IS
  'C2-2: COA bank/card/gateway chosen at upload; worker blocks link if file IBAN ≠ account IBAN';
