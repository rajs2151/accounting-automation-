-- P5-2: fixed asset register + monthly straight-line depreciation runs.
-- Additive + idempotent.

ALTER TABLE books_journal_entries
  DROP CONSTRAINT IF EXISTS books_journal_entries_entry_type_check;

ALTER TABLE books_journal_entries
  ADD CONSTRAINT books_journal_entries_entry_type_check
  CHECK (entry_type IN ('manual', 'auto', 'closing', 'opening', 'reversal', 'depreciation'));

CREATE TABLE IF NOT EXISTS books_fixed_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  name text NOT NULL,
  asset_account_id uuid NOT NULL REFERENCES books_accounts(id),
  accumulated_account_id uuid NOT NULL REFERENCES books_accounts(id),
  expense_account_id uuid NOT NULL REFERENCES books_accounts(id),
  cost_minor bigint NOT NULL CHECK (cost_minor > 0),
  residual_minor bigint NOT NULL DEFAULT 0 CHECK (residual_minor >= 0),
  in_service_date date NOT NULL,
  life_months int NOT NULL CHECK (life_months > 0),
  method text NOT NULL DEFAULT 'straight_line'
    CHECK (method IN ('straight_line')),
  disposed_at date,
  source_journal_entry_id uuid REFERENCES books_journal_entries(id),
  source_document_id uuid REFERENCES books_documents(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (residual_minor < cost_minor)
);

CREATE TABLE IF NOT EXISTS books_depreciation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  asset_id uuid NOT NULL REFERENCES books_fixed_assets(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES books_periods(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  journal_entry_id uuid NOT NULL REFERENCES books_journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, period_id)
);

CREATE INDEX IF NOT EXISTS books_fixed_assets_client_idx
  ON books_fixed_assets (client_id, in_service_date);
CREATE INDEX IF NOT EXISTS books_depreciation_runs_period_idx
  ON books_depreciation_runs (client_id, period_id);
CREATE INDEX IF NOT EXISTS books_depreciation_runs_journal_idx
  ON books_depreciation_runs (journal_entry_id);

COMMENT ON TABLE books_fixed_assets IS
  'P5-2: fixed asset register. Depreciation = straight-line; first month = month of in_service_date (full month).';
COMMENT ON TABLE books_depreciation_runs IS
  'P5-2: one run row per asset×period; amount in fils; journal is JV entry_type=depreciation.';

ALTER TABLE books_fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_fixed_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE books_depreciation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_depreciation_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS books_fixed_assets_read ON books_fixed_assets;
DROP POLICY IF EXISTS books_fixed_assets_insert ON books_fixed_assets;
DROP POLICY IF EXISTS books_fixed_assets_update ON books_fixed_assets;
DROP POLICY IF EXISTS books_fixed_assets_delete ON books_fixed_assets;
CREATE POLICY books_fixed_assets_read ON books_fixed_assets
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_fixed_assets_insert ON books_fixed_assets
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_fixed_assets_update ON books_fixed_assets
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_fixed_assets_delete ON books_fixed_assets
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant')
  );

DROP POLICY IF EXISTS books_depreciation_runs_read ON books_depreciation_runs;
DROP POLICY IF EXISTS books_depreciation_runs_insert ON books_depreciation_runs;
DROP POLICY IF EXISTS books_depreciation_runs_update ON books_depreciation_runs;
DROP POLICY IF EXISTS books_depreciation_runs_delete ON books_depreciation_runs;
CREATE POLICY books_depreciation_runs_read ON books_depreciation_runs
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_depreciation_runs_insert ON books_depreciation_runs
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_depreciation_runs_update ON books_depreciation_runs
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_depreciation_runs_delete ON books_depreciation_runs
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON books_fixed_assets TO daftar_app, daftar_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON books_depreciation_runs TO daftar_app, daftar_worker;
