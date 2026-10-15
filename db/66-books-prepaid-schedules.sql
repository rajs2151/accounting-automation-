-- Phase 3 rank 1: prepayment amortisation schedules + prepaid_release job kind.

ALTER TABLE books_documents
  ADD COLUMN IF NOT EXISTS amortise_prepaid boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS books_prepaid_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  document_id uuid NOT NULL REFERENCES books_documents(id),
  release_date date NOT NULL,
  period_id uuid REFERENCES books_periods(id),
  amount_aed_minor bigint NOT NULL,
  expense_account_id uuid NOT NULL REFERENCES books_accounts(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'posted', 'blocked', 'cancelled')),
  journal_entry_id uuid REFERENCES books_journal_entries(id),
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS books_prepaid_schedules_client_release_idx
  ON books_prepaid_schedules (client_id, release_date)
  WHERE status IN ('pending', 'blocked');

ALTER TABLE books_jobs DROP CONSTRAINT IF EXISTS books_jobs_kind_check;
ALTER TABLE books_jobs ADD CONSTRAINT books_jobs_kind_check
  CHECK (kind IN (
    'schedule_post', 'recurring_materialize', 'auto_reverse',
    'extract_document', 'classify_document', 'deferred_release', 'prepaid_release'
  ));

DO $$
DECLARE
  tbl text := 'books_prepaid_schedules';
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_read', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_insert', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_update', tbl);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_delete', tbl);
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR SELECT USING (
       client_id IN (SELECT visible_client_ids())
     )',
    tbl || '_read', tbl
  );
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
       client_id IN (SELECT visible_client_ids())
       AND app_role() IN (''admin'', ''accountant'', ''approver'')
     )',
    tbl || '_insert', tbl
  );
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR UPDATE USING (
       client_id IN (SELECT visible_client_ids())
     ) WITH CHECK (
       client_id IN (SELECT visible_client_ids())
       AND app_role() IN (''admin'', ''accountant'', ''approver'')
     )',
    tbl || '_update', tbl
  );
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR DELETE USING (
       client_id IN (SELECT visible_client_ids())
       AND app_role() IN (''admin'', ''accountant'', ''approver'')
     )',
    tbl || '_delete', tbl
  );
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON books_prepaid_schedules TO daftar_app, daftar_worker;
