-- P2A-2: Remember rejected match suggestions; store last score breakdown on bank txn.

ALTER TABLE books_bank_transactions
  ADD COLUMN IF NOT EXISTS match_score numeric(5,4),
  ADD COLUMN IF NOT EXISTS match_score_breakdown jsonb,
  ADD COLUMN IF NOT EXISTS match_band text
    CHECK (match_band IS NULL OR match_band IN ('ready', 'suggested', 'none'));

CREATE TABLE IF NOT EXISTS books_bank_txn_rejected_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  bank_txn_id uuid NOT NULL REFERENCES books_bank_transactions(id) ON DELETE CASCADE,
  open_item_id uuid NOT NULL REFERENCES books_open_items(id),
  rejected_by uuid REFERENCES users(id),
  rejected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_txn_id, open_item_id)
);

CREATE INDEX IF NOT EXISTS books_bank_txn_rejected_txn_idx
  ON books_bank_txn_rejected_matches (client_id, bank_txn_id);

COMMENT ON TABLE books_bank_txn_rejected_matches IS
  'P2A-2: rejected open-item suggestions are never re-suggested for this bank txn';

ALTER TABLE books_bank_txn_rejected_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_bank_txn_rejected_matches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS books_bank_txn_rejected_read ON books_bank_txn_rejected_matches;
DROP POLICY IF EXISTS books_bank_txn_rejected_insert ON books_bank_txn_rejected_matches;
DROP POLICY IF EXISTS books_bank_txn_rejected_delete ON books_bank_txn_rejected_matches;

CREATE POLICY books_bank_txn_rejected_read ON books_bank_txn_rejected_matches
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));

CREATE POLICY books_bank_txn_rejected_insert ON books_bank_txn_rejected_matches
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

CREATE POLICY books_bank_txn_rejected_delete ON books_bank_txn_rejected_matches
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

GRANT SELECT, INSERT, DELETE ON books_bank_txn_rejected_matches TO daftar_app, daftar_worker;
