-- C3-2: 1:1 open-item match + journal link on books_bank_transactions.

ALTER TABLE books_bank_transactions
  ADD COLUMN IF NOT EXISTS open_item_id uuid REFERENCES books_open_items(id),
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid REFERENCES books_journal_entries(id),
  ADD COLUMN IF NOT EXISTS settlement_document_id uuid REFERENCES books_documents(id),
  ADD COLUMN IF NOT EXISTS posted_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS posted_at timestamptz;

CREATE INDEX IF NOT EXISTS books_bank_txn_open_item_idx
  ON books_bank_transactions (client_id, open_item_id)
  WHERE open_item_id IS NOT NULL;

COMMENT ON COLUMN books_bank_transactions.open_item_id IS
  'C3-2: optional 1:1 AR/AP open item match before post';
COMMENT ON COLUMN books_bank_transactions.journal_entry_id IS
  'C3-2: posted journal (immutable link)';
