-- P5-3: per-company FX rate table + month-end unrealised revaluation runs.
-- Additive + idempotent.

ALTER TABLE books_journal_entries
  DROP CONSTRAINT IF EXISTS books_journal_entries_entry_type_check;

ALTER TABLE books_journal_entries
  ADD CONSTRAINT books_journal_entries_entry_type_check
  CHECK (entry_type IN (
    'manual', 'auto', 'closing', 'opening', 'reversal', 'depreciation', 'fx_revaluation'
  ));

-- 1121 is the USD bank in the UAE SME COA; template copy previously forced AED.
UPDATE books_accounts SET currency = 'USD' WHERE code = '1121';

CREATE OR REPLACE FUNCTION books_copy_coa_template(p_client_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  parent uuid;
  acct_ccy char(3);
BEGIN
  FOR r IN SELECT * FROM books_coa_template ORDER BY sort_order, code LOOP
    parent := NULL;
    IF r.parent_code IS NOT NULL THEN
      SELECT id INTO parent FROM books_accounts
      WHERE client_id = p_client_id AND code = r.parent_code;
    END IF;
    acct_ccy := CASE WHEN r.code = '1121' THEN 'USD' ELSE 'AED' END;
    INSERT INTO books_accounts (
      client_id, code, name, account_type, parent_id, is_postable, normal_balance,
      is_ar, is_ap, is_vat_control, is_bank, is_control, is_contra, sub_type,
      cash_flow_class, statement_line, note_group, template_code, default_vat_code,
      currency, active
    ) VALUES (
      p_client_id, r.code, r.name, r.account_type, parent, r.is_postable, r.normal_balance,
      r.is_ar, r.is_ap, r.is_vat_control, r.is_bank, r.is_control, COALESCE(r.is_contra, false), r.sub_type,
      r.cash_flow_class, r.statement_line, r.note_group, r.code, r.default_vat_code,
      acct_ccy, true
    )
    ON CONFLICT (client_id, code) DO UPDATE SET
      name = EXCLUDED.name,
      parent_id = EXCLUDED.parent_id,
      is_postable = EXCLUDED.is_postable,
      normal_balance = EXCLUDED.normal_balance,
      is_control = EXCLUDED.is_control,
      is_contra = EXCLUDED.is_contra,
      sub_type = EXCLUDED.sub_type,
      default_vat_code = EXCLUDED.default_vat_code,
      template_code = EXCLUDED.template_code,
      is_ar = EXCLUDED.is_ar,
      is_ap = EXCLUDED.is_ap,
      is_vat_control = EXCLUDED.is_vat_control,
      is_bank = EXCLUDED.is_bank,
      currency = EXCLUDED.currency,
      active = true;
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS books_fx_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  currency char(3) NOT NULL,
  rate_date date NOT NULL,
  rate_scaled bigint NOT NULL CHECK (rate_scaled > 0),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual')),
  entered_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, currency, rate_date),
  CHECK (currency <> 'AED')
);

CREATE TABLE IF NOT EXISTS books_fx_revaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  period_id uuid NOT NULL REFERENCES books_periods(id),
  journal_entry_id uuid REFERENCES books_journal_entries(id),
  kind text NOT NULL DEFAULT 'journal' CHECK (kind IN ('journal', 'noop')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, period_id)
);

CREATE INDEX IF NOT EXISTS books_fx_rates_client_date_idx
  ON books_fx_rates (client_id, rate_date DESC, currency);
CREATE INDEX IF NOT EXISTS books_fx_revaluation_runs_period_idx
  ON books_fx_revaluation_runs (client_id, period_id);

COMMENT ON TABLE books_fx_rates IS
  'P5-3: manual period-end rates to AED (scale 1e8). Never invent rates.';
COMMENT ON TABLE books_fx_revaluation_runs IS
  'P5-3: one revaluation run per period; journal = draft/posted JV entry_type=fx_revaluation, or noop when diffs are zero.';

ALTER TABLE books_fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_fx_rates FORCE ROW LEVEL SECURITY;
ALTER TABLE books_fx_revaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_fx_revaluation_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS books_fx_rates_read ON books_fx_rates;
DROP POLICY IF EXISTS books_fx_rates_insert ON books_fx_rates;
DROP POLICY IF EXISTS books_fx_rates_update ON books_fx_rates;
DROP POLICY IF EXISTS books_fx_rates_delete ON books_fx_rates;
CREATE POLICY books_fx_rates_read ON books_fx_rates
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_fx_rates_insert ON books_fx_rates
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_fx_rates_update ON books_fx_rates
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_fx_rates_delete ON books_fx_rates
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant')
  );

DROP POLICY IF EXISTS books_fx_revaluation_runs_read ON books_fx_revaluation_runs;
DROP POLICY IF EXISTS books_fx_revaluation_runs_insert ON books_fx_revaluation_runs;
DROP POLICY IF EXISTS books_fx_revaluation_runs_update ON books_fx_revaluation_runs;
DROP POLICY IF EXISTS books_fx_revaluation_runs_delete ON books_fx_revaluation_runs;
CREATE POLICY books_fx_revaluation_runs_read ON books_fx_revaluation_runs
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_fx_revaluation_runs_insert ON books_fx_revaluation_runs
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_fx_revaluation_runs_update ON books_fx_revaluation_runs
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_fx_revaluation_runs_delete ON books_fx_revaluation_runs
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON books_fx_rates TO daftar_app, daftar_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON books_fx_revaluation_runs TO daftar_app, daftar_worker;
