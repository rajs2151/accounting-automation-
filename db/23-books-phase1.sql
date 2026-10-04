-- Phase 1 + Addendum A: parties, documents, open items, extraction, statement staging, opening import.

-- ---------------------------------------------------------------------------
-- VAT codes (global catalog; RCM split for VAT201 Box 3/10 later)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS books_vat_codes (
  code text PRIMARY KEY,
  name text NOT NULL,
  rate_bp int NOT NULL DEFAULT 0 CHECK (rate_bp >= 0 AND rate_bp <= 10000),
  direction text NOT NULL CHECK (direction IN ('output', 'input', 'either', 'none')),
  recoverable boolean NOT NULL DEFAULT true,
  vat201_box text,
  active boolean NOT NULL DEFAULT true
);

INSERT INTO books_vat_codes (code, name, rate_bp, direction, recoverable, vat201_box) VALUES
  ('SR', 'Standard rated 5%', 500, 'either', true, '1a'),
  ('ZR', 'Zero-rated', 0, 'either', true, '6'),
  ('EX', 'Exempt', 0, 'either', false, '8'),
  ('OS', 'Out of scope', 0, 'none', false, NULL),
  ('RC_OUT', 'Reverse charge output', 500, 'output', true, '3'),
  ('RC_IN', 'Reverse charge input', 500, 'input', true, '10'),
  ('NR', 'Blocked / non-recoverable input', 500, 'input', false, NULL)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  rate_bp = EXCLUDED.rate_bp,
  direction = EXCLUDED.direction,
  recoverable = EXCLUDED.recoverable,
  vat201_box = EXCLUDED.vat201_box;

-- Free zone → emirate map (seed; extend as ops supply list)
CREATE TABLE IF NOT EXISTS books_free_zone_emirate (
  free_zone text PRIMARY KEY,
  emirate text NOT NULL
);

INSERT INTO books_free_zone_emirate (free_zone, emirate) VALUES
  ('Meydan', 'Dubai'),
  ('RAKEZ', 'Ras Al Khaimah'),
  ('IFZA', 'Dubai'),
  ('DMCC', 'Dubai'),
  ('DSO', 'Dubai'),
  ('JAFZA', 'Dubai'),
  ('SPC Free Zone', 'Sharjah')
ON CONFLICT (free_zone) DO NOTHING;

-- Company books-start period (for OB import)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS books_start_period_id uuid REFERENCES books_periods(id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS trn text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS default_iban text;

-- ---------------------------------------------------------------------------
-- Parties
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS books_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  party_type text NOT NULL CHECK (party_type IN ('customer', 'supplier')),
  name text NOT NULL,
  trn text,
  country char(2) NOT NULL DEFAULT 'AE',
  emirate text,
  zone text CHECK (zone IS NULL OR zone IN ('mainland', 'free_zone', 'designated_zone')),
  default_account_id uuid REFERENCES books_accounts(id),
  default_vat_code text REFERENCES books_vat_codes(code),
  payment_terms_days int NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, party_type, name)
);

CREATE INDEX IF NOT EXISTS books_parties_client_idx ON books_parties (client_id, party_type, name);
CREATE INDEX IF NOT EXISTS books_parties_trn_idx ON books_parties (client_id, trn) WHERE trn IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Files / inbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS books_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id), -- NULL = Unassigned inbox
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  byte_size bigint NOT NULL DEFAULT 0,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sha256)
);

CREATE TABLE IF NOT EXISTS books_inbox_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id), -- NULL = Unassigned
  file_id uuid NOT NULL REFERENCES books_files(id),
  detected_type text,
  classification_confidence numeric(5,4),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'extracting', 'needs_review', 'ready', 'confirmed', 'failed', 'routed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS books_inbox_client_idx ON books_inbox_items (client_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Extractions (invoice/bill/receipt/TB)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS books_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id),
  file_id uuid NOT NULL REFERENCES books_files(id),
  inbox_item_id uuid REFERENCES books_inbox_items(id),
  doc_type text,
  status text NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('ready', 'needs_review', 'failed')),
  fields_json jsonb NOT NULL DEFAULT '{}',
  raw_text text,
  word_boxes jsonb NOT NULL DEFAULT '[]',
  validation_flags jsonb NOT NULL DEFAULT '[]',
  extractor_version text NOT NULL DEFAULT 'phase1-v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS books_source_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id), -- NULL = global/preset
  issuer_key text NOT NULL,
  doc_type text NOT NULL,
  file_type text NOT NULL DEFAULT 'pdf',
  header_fingerprint text NOT NULL DEFAULT '',
  column_map jsonb NOT NULL DEFAULT '{}',
  layout_json jsonb NOT NULL DEFAULT '{}',
  date_format text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer_key, doc_type, file_type, header_fingerprint)
);

-- ---------------------------------------------------------------------------
-- Statement staging (Phase 1 only — Phase 2 bank_transaction consumes later)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS books_statement_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id),
  file_id uuid NOT NULL REFERENCES books_files(id),
  inbox_item_id uuid REFERENCES books_inbox_items(id),
  account_label text,
  iban text,
  bank_name text,
  account_holder text,
  currency char(3) NOT NULL DEFAULT 'AED',
  period_from date,
  period_to date,
  opening_balance_minor bigint,
  closing_balance_minor bigint,
  status text NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('ready', 'needs_review', 'failed', 'confirmed')),
  validation_flags jsonb NOT NULL DEFAULT '[]',
  extractor_version text NOT NULL DEFAULT 'phase1-v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS books_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL REFERENCES books_statement_extractions(id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients(id),
  line_date date,
  value_date date,
  description text NOT NULL DEFAULT '',
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  running_balance_minor bigint,
  reference text,
  currency char(3) NOT NULL DEFAULT 'AED',
  source_bbox jsonb,
  confidence numeric(5,4),
  flags text[] NOT NULL DEFAULT '{}',
  sort_index int NOT NULL DEFAULT 0,
  CHECK (NOT (debit_minor > 0 AND credit_minor > 0))
);

CREATE INDEX IF NOT EXISTS books_statement_lines_stmt_idx
  ON books_statement_lines (statement_id, sort_index);

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS books_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  doc_type text NOT NULL CHECK (doc_type IN (
    'sales_invoice', 'purchase_bill', 'credit_note', 'debit_note',
    'receipt', 'payment', 'contra', 'opening'
  )),
  doc_kind text CHECK (doc_kind IS NULL OR doc_kind IN ('customer', 'supplier')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'approved', 'posted', 'partially_paid', 'paid', 'void'
  )),
  voucher_type text,
  document_number text,
  party_id uuid REFERENCES books_parties(id),
  issue_date date,
  due_date date,
  service_start date,
  service_end date,
  defer_revenue boolean NOT NULL DEFAULT false,
  currency char(3) NOT NULL DEFAULT 'AED',
  fx_rate_scaled bigint NOT NULL DEFAULT 100000000, -- ×1e8; 1.0 AED = 100000000
  original_total_minor bigint NOT NULL DEFAULT 0,
  aed_total_minor bigint NOT NULL DEFAULT 0,
  net_minor bigint NOT NULL DEFAULT 0,
  vat_minor bigint NOT NULL DEFAULT 0,
  gross_minor bigint NOT NULL DEFAULT 0,
  memo text NOT NULL DEFAULT '',
  original_document_id uuid REFERENCES books_documents(id),
  journal_entry_id uuid REFERENCES books_journal_entries(id),
  extraction_id uuid REFERENCES books_extractions(id),
  file_id uuid REFERENCES books_files(id),
  bank_account_id uuid REFERENCES books_accounts(id),
  contra_account_id uuid REFERENCES books_accounts(id),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS books_documents_client_idx
  ON books_documents (client_id, doc_type, status, issue_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS books_documents_dedupe_uidx
  ON books_documents (client_id, doc_type, document_number, party_id, aed_total_minor)
  WHERE deleted_at IS NULL AND status <> 'void' AND document_number IS NOT NULL AND party_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS books_document_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES books_documents(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  line_no int NOT NULL DEFAULT 1,
  description text NOT NULL DEFAULT '',
  quantity_scaled bigint NOT NULL DEFAULT 1000, -- ×1000
  unit_price_minor bigint NOT NULL DEFAULT 0,
  line_kind text NOT NULL DEFAULT 'revenue'
    CHECK (line_kind IN ('revenue', 'disbursement', 'taxable_recharge', 'expense', 'asset', 'inventory')),
  account_id uuid REFERENCES books_accounts(id),
  vat_code text REFERENCES books_vat_codes(code),
  net_minor bigint NOT NULL DEFAULT 0,
  vat_minor bigint NOT NULL DEFAULT 0,
  gross_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'AED',
  original_minor bigint,
  fx_rate_scaled bigint,
  aed_minor bigint,
  tags text[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS books_document_lines_doc_idx ON books_document_lines (document_id, line_no);

-- ---------------------------------------------------------------------------
-- Open items + allocations + advances
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS books_open_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  party_id uuid NOT NULL REFERENCES books_parties(id),
  document_id uuid REFERENCES books_documents(id),
  journal_entry_id uuid NOT NULL REFERENCES books_journal_entries(id),
  side text NOT NULL CHECK (side IN ('AR', 'AP')),
  currency char(3) NOT NULL DEFAULT 'AED',
  original_minor bigint NOT NULL,
  aed_original_minor bigint NOT NULL,
  open_original_minor bigint NOT NULL,
  open_aed_minor bigint NOT NULL,
  fx_rate_scaled bigint NOT NULL DEFAULT 100000000,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS books_open_items_party_idx
  ON books_open_items (client_id, party_id, status);

CREATE TABLE IF NOT EXISTS books_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  settlement_document_id uuid NOT NULL REFERENCES books_documents(id),
  settlement_journal_id uuid NOT NULL REFERENCES books_journal_entries(id),
  open_item_id uuid NOT NULL REFERENCES books_open_items(id),
  allocated_original_minor bigint NOT NULL CHECK (allocated_original_minor > 0),
  allocated_aed_minor bigint NOT NULL CHECK (allocated_aed_minor > 0),
  fx_gain_loss_aed_minor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS books_party_advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  party_id uuid NOT NULL REFERENCES books_parties(id),
  currency char(3) NOT NULL DEFAULT 'AED',
  balance_original_minor bigint NOT NULL DEFAULT 0,
  balance_aed_minor bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, party_id, currency)
);

-- ---------------------------------------------------------------------------
-- Opening imports + deferred schedules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS books_opening_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  file_id uuid REFERENCES books_files(id),
  as_of_date date NOT NULL,
  period_id uuid NOT NULL REFERENCES books_periods(id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'mapped', 'posted', 'rejected')),
  mapping_json jsonb NOT NULL DEFAULT '{}',
  balance_debit_minor bigint NOT NULL DEFAULT 0,
  balance_credit_minor bigint NOT NULL DEFAULT 0,
  journal_entry_id uuid REFERENCES books_journal_entries(id),
  error text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS books_deferred_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  document_id uuid NOT NULL REFERENCES books_documents(id),
  release_date date NOT NULL,
  period_id uuid REFERENCES books_periods(id),
  amount_aed_minor bigint NOT NULL,
  revenue_account_id uuid NOT NULL REFERENCES books_accounts(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'posted', 'blocked', 'cancelled')),
  journal_entry_id uuid REFERENCES books_journal_entries(id),
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Extend books_jobs kinds
ALTER TABLE books_jobs DROP CONSTRAINT IF EXISTS books_jobs_kind_check;
ALTER TABLE books_jobs ADD CONSTRAINT books_jobs_kind_check
  CHECK (kind IN (
    'schedule_post', 'recurring_materialize', 'auto_reverse',
    'extract_document', 'classify_document', 'deferred_release'
  ));

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'books_parties', 'books_files', 'books_inbox_items', 'books_extractions',
    'books_source_profiles', 'books_statement_extractions', 'books_statement_lines',
    'books_documents', 'books_document_lines', 'books_open_items', 'books_allocations',
    'books_party_advances', 'books_opening_imports', 'books_deferred_schedules'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_read', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_insert', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_update', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_delete', tbl);
    -- Allow NULL client_id rows (Unassigned) for files/inbox/extractions/statements/profiles
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (
         client_id IS NULL OR client_id IN (SELECT visible_client_ids())
       )',
      tbl || '_read', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
         (client_id IS NULL OR client_id IN (SELECT visible_client_ids()))
         AND app_role() IN (''admin'', ''accountant'', ''approver'')
       )',
      tbl || '_insert', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (
         client_id IS NULL OR client_id IN (SELECT visible_client_ids())
       ) WITH CHECK (
         (client_id IS NULL OR client_id IN (SELECT visible_client_ids()))
         AND app_role() IN (''admin'', ''accountant'', ''approver'')
       )',
      tbl || '_update', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (
         (client_id IS NULL OR client_id IN (SELECT visible_client_ids()))
         AND app_role() IN (''admin'', ''accountant'', ''approver'')
       )',
      tbl || '_delete', tbl
    );
  END LOOP;
END $$;

GRANT SELECT ON books_vat_codes, books_free_zone_emirate TO daftar_app, daftar_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  books_parties, books_files, books_inbox_items, books_extractions,
  books_source_profiles, books_statement_extractions, books_statement_lines,
  books_documents, books_document_lines, books_open_items, books_allocations,
  books_party_advances, books_opening_imports, books_deferred_schedules
TO daftar_app, daftar_worker;
