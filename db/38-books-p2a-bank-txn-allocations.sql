-- P2A-1: Draft allocations on bank transactions (1:N / N:1 / differences / on-account / advance).
-- Posted settlements still write books_allocations; this table is the pre-post plan.

CREATE TABLE IF NOT EXISTS books_bank_txn_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  bank_txn_id uuid NOT NULL REFERENCES books_bank_transactions(id) ON DELETE CASCADE,
  alloc_kind text NOT NULL
    CHECK (alloc_kind IN (
      'against_item', 'on_account', 'advance', 'bank_fee', 'fx_difference', 'discount'
    )),
  open_item_id uuid REFERENCES books_open_items(id),
  account_id uuid REFERENCES books_accounts(id),
  party_id uuid REFERENCES books_parties(id),
  amount_original_minor bigint NOT NULL CHECK (amount_original_minor > 0),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (alloc_kind = 'against_item' AND open_item_id IS NOT NULL)
    OR (alloc_kind IN ('on_account', 'advance') AND party_id IS NOT NULL AND open_item_id IS NULL)
    OR (alloc_kind IN ('bank_fee', 'fx_difference', 'discount') AND account_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS books_bank_txn_alloc_txn_idx
  ON books_bank_txn_allocations (client_id, bank_txn_id);

CREATE INDEX IF NOT EXISTS books_bank_txn_alloc_oi_idx
  ON books_bank_txn_allocations (client_id, open_item_id)
  WHERE open_item_id IS NOT NULL;

COMMENT ON TABLE books_bank_txn_allocations IS
  'P2A-1: draft split match / differences before post; unallocated must be 0 to mark Ready';
COMMENT ON COLUMN books_bank_txn_allocations.alloc_kind IS
  'against_item | on_account | advance (no VAT — owner TBD) | bank_fee | fx_difference | discount';

ALTER TABLE books_bank_txn_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_bank_txn_allocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS books_bank_txn_alloc_read ON books_bank_txn_allocations;
DROP POLICY IF EXISTS books_bank_txn_alloc_insert ON books_bank_txn_allocations;
DROP POLICY IF EXISTS books_bank_txn_alloc_update ON books_bank_txn_allocations;
DROP POLICY IF EXISTS books_bank_txn_alloc_delete ON books_bank_txn_allocations;

CREATE POLICY books_bank_txn_alloc_read ON books_bank_txn_allocations
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));

CREATE POLICY books_bank_txn_alloc_insert ON books_bank_txn_allocations
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

CREATE POLICY books_bank_txn_alloc_update ON books_bank_txn_allocations
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

CREATE POLICY books_bank_txn_alloc_delete ON books_bank_txn_allocations
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON books_bank_txn_allocations TO daftar_app, daftar_worker;
