-- C3-3: mutual link between two transfer bank txns (posted as one Contra).

ALTER TABLE books_bank_transactions
  ADD COLUMN IF NOT EXISTS linked_txn_id uuid REFERENCES books_bank_transactions(id);

CREATE UNIQUE INDEX IF NOT EXISTS books_bank_txn_linked_unique
  ON books_bank_transactions (linked_txn_id)
  WHERE linked_txn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS books_bank_txn_linked_lookup_idx
  ON books_bank_transactions (client_id, linked_txn_id)
  WHERE linked_txn_id IS NOT NULL;

COMMENT ON COLUMN books_bank_transactions.linked_txn_id IS
  'C3-3: counterpart transfer txn (mutual); post → one Contra CV';
