-- P3-1: Expenses draft schema (CrossVal Expenses). Approval/post in P3-2.
-- Voucher series EXP-YYYY-#### via books_voucher_sequences type 'Expense'.
-- Paid-from employee reimbursable uses existing COA 2130 (no new account).

CREATE OR REPLACE FUNCTION books_voucher_prefix(p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_type
    WHEN 'Sales' THEN 'SV'
    WHEN 'Purchase' THEN 'PV'
    WHEN 'Receipt' THEN 'RV'
    WHEN 'Payment' THEN 'PY'
    WHEN 'Contra' THEN 'CV'
    WHEN 'Journal' THEN 'JV'
    WHEN 'Credit Note' THEN 'CN'
    WHEN 'Debit Note' THEN 'DN'
    WHEN 'Opening' THEN 'OB'
    WHEN 'Closing' THEN 'CL'
    WHEN 'Expense' THEN 'EXP'
    ELSE 'JV'
  END;
$$;

INSERT INTO books_voucher_sequences (client_id, voucher_type, year, prefix, last_n)
SELECT c.id, 'Expense', 2026, 'EXP', 0
FROM clients c
WHERE c.is_synthetic = true
ON CONFLICT (client_id, voucher_type, year) DO NOTHING;

-- Allow Expense on journal entries (EXP series).
ALTER TABLE books_journal_entries
  DROP CONSTRAINT IF EXISTS books_journal_entries_voucher_type_check;
ALTER TABLE books_journal_entries
  ADD CONSTRAINT books_journal_entries_voucher_type_check
  CHECK (
    voucher_type IS NULL OR voucher_type IN (
      'Sales', 'Purchase', 'Receipt', 'Payment', 'Contra', 'Journal',
      'Credit Note', 'Debit Note', 'Opening', 'Closing', 'Expense'
    )
  );

-- Receipt mandatory above this amount (fils). NULL = not enforced yet (owner TBD).
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS expense_receipt_threshold_minor bigint
  CHECK (expense_receipt_threshold_minor IS NULL OR expense_receipt_threshold_minor >= 0);

COMMENT ON COLUMN clients.expense_receipt_threshold_minor IS
  'P3: receipt required when expense gross > this (fils). NULL = policy not set (do not invent default).';

CREATE TABLE IF NOT EXISTS books_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  expense_no text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  expense_date date NOT NULL,
  period_id uuid NOT NULL REFERENCES books_periods(id),
  description text NOT NULL DEFAULT '',
  vendor_party_id uuid REFERENCES books_parties(id),
  vendor_name text NOT NULL DEFAULT '',
  currency char(3) NOT NULL DEFAULT 'AED',
  paid_from_kind text
    CHECK (
      paid_from_kind IS NULL OR paid_from_kind IN (
        'bank', 'card', 'petty_cash', 'employee_reimbursable'
      )
    ),
  paid_from_account_id uuid REFERENCES books_accounts(id),
  net_minor bigint NOT NULL DEFAULT 0 CHECK (net_minor >= 0),
  vat_minor bigint NOT NULL DEFAULT 0 CHECK (vat_minor >= 0),
  gross_minor bigint NOT NULL DEFAULT 0 CHECK (gross_minor >= 0),
  CHECK (gross_minor = net_minor + vat_minor),
  submitted_by uuid REFERENCES users(id),
  submitted_at timestamptz,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  rejected_by uuid REFERENCES users(id),
  rejected_at timestamptz,
  rejection_reason text,
  journal_entry_id uuid REFERENCES books_journal_entries(id),
  bank_txn_id uuid,
  note text NOT NULL DEFAULT '',
  deleted_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, expense_no)
);

DO $$
BEGIN
  IF to_regclass('books_bank_transactions') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'books_expenses_bank_txn_id_fkey'
     ) THEN
    ALTER TABLE books_expenses
      ADD CONSTRAINT books_expenses_bank_txn_id_fkey
      FOREIGN KEY (bank_txn_id) REFERENCES books_bank_transactions(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS books_expenses_client_status_idx
  ON books_expenses (client_id, status, expense_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS books_expenses_client_date_idx
  ON books_expenses (client_id, expense_date DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS books_expense_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES books_expenses(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  line_no int NOT NULL CHECK (line_no > 0),
  description text NOT NULL DEFAULT '',
  account_id uuid NOT NULL REFERENCES books_accounts(id),
  vat_code text REFERENCES books_vat_codes(code),
  net_minor bigint NOT NULL CHECK (net_minor >= 0),
  vat_minor bigint NOT NULL DEFAULT 0 CHECK (vat_minor >= 0),
  gross_minor bigint NOT NULL CHECK (gross_minor >= 0),
  CHECK (gross_minor = net_minor + vat_minor),
  UNIQUE (expense_id, line_no)
);

CREATE INDEX IF NOT EXISTS books_expense_lines_expense_idx
  ON books_expense_lines (expense_id, line_no);

CREATE TABLE IF NOT EXISTS books_expense_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES books_expenses(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  file_id uuid NOT NULL REFERENCES books_files(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expense_id, file_id)
);

COMMENT ON TABLE books_expenses IS
  'P3: staff expense claims — draft/pending/approved/rejected; journal only on approve (P3-2)';

ALTER TABLE books_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_expenses FORCE ROW LEVEL SECURITY;
ALTER TABLE books_expense_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_expense_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE books_expense_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_expense_files FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS books_expenses_read ON books_expenses;
DROP POLICY IF EXISTS books_expenses_insert ON books_expenses;
DROP POLICY IF EXISTS books_expenses_update ON books_expenses;
DROP POLICY IF EXISTS books_expenses_delete ON books_expenses;
CREATE POLICY books_expenses_read ON books_expenses
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_expenses_insert ON books_expenses
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_expenses_update ON books_expenses
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_expenses_delete ON books_expenses
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant')
  );

DROP POLICY IF EXISTS books_expense_lines_read ON books_expense_lines;
DROP POLICY IF EXISTS books_expense_lines_insert ON books_expense_lines;
DROP POLICY IF EXISTS books_expense_lines_update ON books_expense_lines;
DROP POLICY IF EXISTS books_expense_lines_delete ON books_expense_lines;
CREATE POLICY books_expense_lines_read ON books_expense_lines
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_expense_lines_insert ON books_expense_lines
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_expense_lines_update ON books_expense_lines
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_expense_lines_delete ON books_expense_lines
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

DROP POLICY IF EXISTS books_expense_files_read ON books_expense_files;
DROP POLICY IF EXISTS books_expense_files_insert ON books_expense_files;
DROP POLICY IF EXISTS books_expense_files_delete ON books_expense_files;
CREATE POLICY books_expense_files_read ON books_expense_files
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_expense_files_insert ON books_expense_files
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_expense_files_delete ON books_expense_files
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON books_expenses TO daftar_app, daftar_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON books_expense_lines TO daftar_app, daftar_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON books_expense_files TO daftar_app, daftar_worker;
