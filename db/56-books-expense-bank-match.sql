-- P3-3: one bank/card line per expense claim (paid-from match).
CREATE UNIQUE INDEX IF NOT EXISTS books_expenses_bank_txn_uidx
  ON books_expenses (bank_txn_id)
  WHERE bank_txn_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN books_expenses.bank_txn_id IS
  'P3-3: matched bank/card outflow; on approve, txn is marked posted with the expense journal (no second payment).';
