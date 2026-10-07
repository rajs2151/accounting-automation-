-- P5-4: year-end close to retained earnings (books).
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS books_year_end_closes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  fiscal_year int NOT NULL,
  period_id uuid NOT NULL REFERENCES books_periods(id),
  journal_entry_id uuid NOT NULL REFERENCES books_journal_entries(id),
  net_income_minor bigint NOT NULL,
  closed_by uuid NOT NULL REFERENCES users(id),
  closed_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '',
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users(id),
  reverse_reason text,
  UNIQUE (client_id, fiscal_year)
);

CREATE INDEX IF NOT EXISTS books_year_end_closes_period_idx
  ON books_year_end_closes (client_id, period_id);

COMMENT ON TABLE books_year_end_closes IS
  'P5-4: one closing entry (entry_type=closing) per fiscal year; P&L reports exclude this entry.';

ALTER TABLE books_year_end_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_year_end_closes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS books_year_end_closes_read ON books_year_end_closes;
DROP POLICY IF EXISTS books_year_end_closes_insert ON books_year_end_closes;
DROP POLICY IF EXISTS books_year_end_closes_update ON books_year_end_closes;
CREATE POLICY books_year_end_closes_read ON books_year_end_closes
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_year_end_closes_insert ON books_year_end_closes
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'approver')
  );
CREATE POLICY books_year_end_closes_update ON books_year_end_closes
  FOR UPDATE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'approver')
  )
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'approver')
  );

GRANT SELECT, INSERT, UPDATE ON books_year_end_closes TO daftar_app, daftar_worker;
