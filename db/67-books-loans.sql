-- Phase 3 rank 9: loan register + monthly interest accrual runs (Dr 7400 / Cr 2420).
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS books_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  name text NOT NULL,
  lender text NOT NULL DEFAULT '',
  principal_minor bigint NOT NULL CHECK (principal_minor > 0),
  -- Annual interest rate in basis points (e.g. 500 = 5.00%).
  annual_rate_bps int NOT NULL CHECK (annual_rate_bps >= 0 AND annual_rate_bps <= 100_000),
  start_date date NOT NULL,
  end_date date,
  liability_account_id uuid NOT NULL REFERENCES books_accounts(id),
  interest_expense_account_id uuid NOT NULL REFERENCES books_accounts(id),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS books_loan_interest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  loan_id uuid NOT NULL REFERENCES books_loans(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES books_periods(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  journal_entry_id uuid NOT NULL REFERENCES books_journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, period_id)
);

CREATE INDEX IF NOT EXISTS books_loans_client_idx ON books_loans (client_id, active);
CREATE INDEX IF NOT EXISTS books_loan_interest_runs_period_idx
  ON books_loan_interest_runs (client_id, period_id);

COMMENT ON TABLE books_loans IS
  'Phase 3 rank 9: simple loan register. Monthly interest = principal × annual_rate_bps / 12 / 10000 (floor fils).';
COMMENT ON TABLE books_loan_interest_runs IS
  'One interest accrual journal per loan × period.';

ALTER TABLE books_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_loans FORCE ROW LEVEL SECURITY;
ALTER TABLE books_loan_interest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_loan_interest_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS books_loans_read ON books_loans;
DROP POLICY IF EXISTS books_loans_insert ON books_loans;
DROP POLICY IF EXISTS books_loans_update ON books_loans;
DROP POLICY IF EXISTS books_loans_delete ON books_loans;
CREATE POLICY books_loans_read ON books_loans
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_loans_insert ON books_loans
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_loans_update ON books_loans
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_loans_delete ON books_loans
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant')
  );

DROP POLICY IF EXISTS books_loan_interest_runs_read ON books_loan_interest_runs;
DROP POLICY IF EXISTS books_loan_interest_runs_insert ON books_loan_interest_runs;
DROP POLICY IF EXISTS books_loan_interest_runs_update ON books_loan_interest_runs;
DROP POLICY IF EXISTS books_loan_interest_runs_delete ON books_loan_interest_runs;
CREATE POLICY books_loan_interest_runs_read ON books_loan_interest_runs
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_loan_interest_runs_insert ON books_loan_interest_runs
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_loan_interest_runs_update ON books_loan_interest_runs
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_loan_interest_runs_delete ON books_loan_interest_runs
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON books_loans TO daftar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON books_loan_interest_runs TO daftar_app;
