-- C3-1: Bank transactions for categorization (Needs Review → Ready → Excluded).
-- Posting / open-item match deferred to later C3 slices. New books_* table only.

CREATE TABLE IF NOT EXISTS books_bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES books_accounts(id),
  statement_id uuid NOT NULL REFERENCES books_statement_extractions(id),
  statement_line_id uuid NOT NULL REFERENCES books_statement_lines(id),
  txn_date date,
  value_date date,
  description text NOT NULL DEFAULT '',
  reference text,
  currency char(3) NOT NULL DEFAULT 'AED',
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  review_status text NOT NULL DEFAULT 'needs_review'
    CHECK (review_status IN ('needs_review', 'ready', 'excluded', 'posted')),
  txn_type text
    CHECK (
      txn_type IS NULL OR txn_type IN (
        'customer_receipt', 'supplier_payment', 'transfer', 'card_repayment',
        'gateway_payout', 'bank_charge', 'owner_capital', 'owner_drawings',
        'loan', 'tax_payment', 'other_income', 'other_expense'
      )
    ),
  category_account_id uuid REFERENCES books_accounts(id),
  note text NOT NULL DEFAULT '',
  exclude_reason text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (statement_line_id),
  CHECK (NOT (debit_minor > 0 AND credit_minor > 0))
);

CREATE INDEX IF NOT EXISTS books_bank_txn_client_status_idx
  ON books_bank_transactions (client_id, review_status, txn_date DESC);

CREATE INDEX IF NOT EXISTS books_bank_txn_account_idx
  ON books_bank_transactions (client_id, account_id, txn_date DESC);

COMMENT ON TABLE books_bank_transactions IS
  'C3: bank/card/gateway lines materialized from statement staging for review (journal post later)';

ALTER TABLE books_bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_bank_transactions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS books_bank_transactions_read ON books_bank_transactions;
DROP POLICY IF EXISTS books_bank_transactions_insert ON books_bank_transactions;
DROP POLICY IF EXISTS books_bank_transactions_update ON books_bank_transactions;
DROP POLICY IF EXISTS books_bank_transactions_delete ON books_bank_transactions;

CREATE POLICY books_bank_transactions_read ON books_bank_transactions
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));

CREATE POLICY books_bank_transactions_insert ON books_bank_transactions
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

CREATE POLICY books_bank_transactions_update ON books_bank_transactions
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

CREATE POLICY books_bank_transactions_delete ON books_bank_transactions
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON books_bank_transactions TO daftar_app, daftar_worker;
