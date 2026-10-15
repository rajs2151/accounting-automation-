-- P2A-3: Bank transaction categorisation rules (no LLM).

CREATE TABLE IF NOT EXISTS books_bank_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  name text NOT NULL,
  priority int NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  -- Conditions (null = ignore)
  counterparty_contains text,
  narration_regex text,
  amount_min_minor bigint,
  amount_max_minor bigint,
  account_id uuid REFERENCES books_accounts(id),
  direction text CHECK (direction IS NULL OR direction IN ('in', 'out')),
  -- Actions
  set_txn_type text
    CHECK (
      set_txn_type IS NULL OR set_txn_type IN (
        'customer_receipt', 'supplier_payment', 'transfer', 'card_repayment',
        'gateway_payout', 'bank_charge', 'owner_capital', 'owner_drawings',
        'loan', 'tax_payment', 'other_income', 'other_expense'
      )
    ),
  set_category_account_id uuid REFERENCES books_accounts(id),
  set_vat_code text,
  set_tags text[] NOT NULL DEFAULT '{}',
  set_counterparty text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS books_bank_rules_client_priority_idx
  ON books_bank_rules (client_id, active, priority ASC, created_at ASC);

COMMENT ON TABLE books_bank_rules IS
  'P2A-3: condition→action rules for bank lines; suggestion chip Rule: <name>';

ALTER TABLE books_bank_transactions
  ADD COLUMN IF NOT EXISTS suggestion_rule_id uuid REFERENCES books_bank_rules(id),
  ADD COLUMN IF NOT EXISTS suggestion_source text;

ALTER TABLE books_bank_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_bank_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS books_bank_rules_read ON books_bank_rules;
DROP POLICY IF EXISTS books_bank_rules_insert ON books_bank_rules;
DROP POLICY IF EXISTS books_bank_rules_update ON books_bank_rules;
DROP POLICY IF EXISTS books_bank_rules_delete ON books_bank_rules;

CREATE POLICY books_bank_rules_read ON books_bank_rules
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));

CREATE POLICY books_bank_rules_insert ON books_bank_rules
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

CREATE POLICY books_bank_rules_update ON books_bank_rules
  FOR UPDATE USING (client_id IN (SELECT visible_client_ids()))
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );

CREATE POLICY books_bank_rules_delete ON books_bank_rules
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON books_bank_rules TO daftar_app, daftar_worker;
