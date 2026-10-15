-- D3: idempotent VAT 201 settlement draft per tax-return window.
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS books_vat201_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  period_from date NOT NULL,
  period_to date NOT NULL,
  -- Signed: credit to 2220 (payable) positive; debit to 2220 (reclaim) negative; 0 when nets equal.
  payable_minor bigint NOT NULL,
  output_net_minor bigint NOT NULL CHECK (output_net_minor >= 0),
  input_net_minor bigint NOT NULL CHECK (input_net_minor >= 0),
  journal_entry_id uuid NOT NULL REFERENCES books_journal_entries(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  UNIQUE (client_id, period_from, period_to)
);

CREATE INDEX IF NOT EXISTS books_vat201_settlements_client_idx
  ON books_vat201_settlements (client_id, period_to DESC);

COMMENT ON TABLE books_vat201_settlements IS
  'D3: one VAT return settlement journal per tax period (from/to). Draft only at prepare; post via dual control.';

ALTER TABLE books_vat201_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_vat201_settlements FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS books_vat201_settlements_read ON books_vat201_settlements;
DROP POLICY IF EXISTS books_vat201_settlements_insert ON books_vat201_settlements;
DROP POLICY IF EXISTS books_vat201_settlements_update ON books_vat201_settlements;
DROP POLICY IF EXISTS books_vat201_settlements_delete ON books_vat201_settlements;
CREATE POLICY books_vat201_settlements_read ON books_vat201_settlements
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_vat201_settlements_insert ON books_vat201_settlements
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_vat201_settlements_update ON books_vat201_settlements
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_vat201_settlements_delete ON books_vat201_settlements
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON books_vat201_settlements TO daftar_app;
