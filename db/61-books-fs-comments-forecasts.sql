-- P6-4: P&L comment threads + @mention notifications + forecast layer.
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS books_comment_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES books_accounts(id),
  period_id uuid NOT NULL REFERENCES books_periods(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, account_id, period_id)
);
CREATE INDEX IF NOT EXISTS books_comment_threads_period_idx
  ON books_comment_threads (client_id, period_id);

CREATE TABLE IF NOT EXISTS books_comment_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  thread_id uuid NOT NULL REFERENCES books_comment_threads(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS books_comment_messages_thread_idx
  ON books_comment_messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS books_comment_reads (
  thread_id uuid NOT NULL REFERENCES books_comment_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS books_comment_reads_client_idx
  ON books_comment_reads (client_id, user_id);

CREATE TABLE IF NOT EXISTS books_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS books_notifications_user_idx
  ON books_notifications (client_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS books_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES books_accounts(id),
  period_id uuid NOT NULL REFERENCES books_periods(id),
  amount_minor bigint NOT NULL,
  method text NOT NULL
    CHECK (method IN ('trailing_avg_3', 'trailing_avg_6', 'linear', 'override')),
  growth_pct numeric(8, 4),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, account_id, period_id)
);
CREATE INDEX IF NOT EXISTS books_forecasts_period_idx
  ON books_forecasts (client_id, period_id);

COMMENT ON TABLE books_comment_threads IS
  'P6-4a: one comment thread per (client, account, period) on FS rows.';
COMMENT ON TABLE books_notifications IS
  'P6-4a: in-app notifications (e.g. @mentions on comment threads).';
COMMENT ON TABLE books_forecasts IS
  'P6-4d: projection layer only — never feeds journals/TB/BS/CT/actuals exports.';

-- Writer tables: preparer/approver/admin.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'books_comment_threads',
    'books_comment_messages',
    'books_forecasts'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_delete', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (client_id IN (SELECT visible_client_ids()))',
      t || '_read', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
         client_id IN (SELECT visible_client_ids())
         AND app_role() IN (''admin'', ''accountant'', ''approver'')
       )',
      t || '_insert', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (
         client_id IN (SELECT visible_client_ids())
         AND app_role() IN (''admin'', ''accountant'', ''approver'')
       ) WITH CHECK (
         client_id IN (SELECT visible_client_ids())
         AND app_role() IN (''admin'', ''accountant'', ''approver'')
       )',
      t || '_update', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (
         client_id IN (SELECT visible_client_ids())
         AND app_role() IN (''admin'', ''accountant'', ''approver'')
       )',
      t || '_delete', t
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO daftar_app, daftar_worker',
      t
    );
  END LOOP;
END $$;

-- Reads: any company user (incl. viewer) can mark threads read.
ALTER TABLE books_comment_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_comment_reads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS books_comment_reads_read ON books_comment_reads;
DROP POLICY IF EXISTS books_comment_reads_insert ON books_comment_reads;
DROP POLICY IF EXISTS books_comment_reads_update ON books_comment_reads;
DROP POLICY IF EXISTS books_comment_reads_delete ON books_comment_reads;
CREATE POLICY books_comment_reads_read ON books_comment_reads
  FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
CREATE POLICY books_comment_reads_insert ON books_comment_reads
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND user_id = app_user_id()
  );
CREATE POLICY books_comment_reads_update ON books_comment_reads
  FOR UPDATE USING (
    client_id IN (SELECT visible_client_ids())
    AND user_id = app_user_id()
  ) WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND user_id = app_user_id()
  );
CREATE POLICY books_comment_reads_delete ON books_comment_reads
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND user_id = app_user_id()
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON books_comment_reads TO daftar_app, daftar_worker;

-- Notifications: company writers create; recipient can read/update own.
ALTER TABLE books_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS books_notifications_read ON books_notifications;
DROP POLICY IF EXISTS books_notifications_insert ON books_notifications;
DROP POLICY IF EXISTS books_notifications_update ON books_notifications;
DROP POLICY IF EXISTS books_notifications_delete ON books_notifications;
CREATE POLICY books_notifications_read ON books_notifications
  FOR SELECT USING (
    client_id IN (SELECT visible_client_ids())
    AND (
      user_id = app_user_id()
      OR app_role() IN ('admin', 'accountant', 'approver')
    )
  );
CREATE POLICY books_notifications_insert ON books_notifications
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'accountant', 'approver')
  );
CREATE POLICY books_notifications_update ON books_notifications
  FOR UPDATE USING (
    client_id IN (SELECT visible_client_ids())
    AND user_id = app_user_id()
  ) WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND user_id = app_user_id()
  );
CREATE POLICY books_notifications_delete ON books_notifications
  FOR DELETE USING (
    client_id IN (SELECT visible_client_ids())
    AND app_role() = 'admin'
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON books_notifications TO daftar_app, daftar_worker;
