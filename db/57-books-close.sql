-- P5-1: books month-end close checklist — waivers, close events, changed-since-close flag.
-- Additive + idempotent.

ALTER TABLE books_periods
  ADD COLUMN IF NOT EXISTS changed_since_close boolean NOT NULL DEFAULT false;

ALTER TABLE books_periods
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

ALTER TABLE books_periods
  ADD COLUMN IF NOT EXISTS closed_by uuid REFERENCES users(id);

COMMENT ON COLUMN books_periods.changed_since_close IS
  'P5-1: true after a journal is posted into a REOPENED period; cleared on successful checklist lock.';

CREATE TABLE IF NOT EXISTS books_close_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  period_id uuid NOT NULL REFERENCES books_periods(id),
  gate_key text NOT NULL,
  reason text NOT NULL,
  actor uuid NOT NULL REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, period_id, gate_key),
  CHECK (btrim(reason) <> '')
);

CREATE TABLE IF NOT EXISTS books_close_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  period_id uuid NOT NULL REFERENCES books_periods(id),
  action text NOT NULL CHECK (action IN ('LOCK', 'UNLOCK', 'WAIVE')),
  actor uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL DEFAULT '',
  checklist_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS books_close_waivers_period_idx
  ON books_close_waivers (client_id, period_id);
CREATE INDEX IF NOT EXISTS books_close_events_period_idx
  ON books_close_events (client_id, period_id, at DESC);

ALTER TABLE books_close_waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_close_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_close_waivers FORCE ROW LEVEL SECURITY;
ALTER TABLE books_close_events FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'books_close_waivers' AND policyname = 'books_close_waivers_read') THEN
    CREATE POLICY books_close_waivers_read ON books_close_waivers
      FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'books_close_waivers' AND policyname = 'books_close_waivers_insert') THEN
    CREATE POLICY books_close_waivers_insert ON books_close_waivers
      FOR INSERT WITH CHECK (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'approver')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'books_close_waivers' AND policyname = 'books_close_waivers_update') THEN
    CREATE POLICY books_close_waivers_update ON books_close_waivers
      FOR UPDATE USING (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'approver')
      )
      WITH CHECK (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'approver')
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'books_close_events' AND policyname = 'books_close_events_read') THEN
    CREATE POLICY books_close_events_read ON books_close_events
      FOR SELECT USING (client_id IN (SELECT visible_client_ids()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'books_close_events' AND policyname = 'books_close_events_insert') THEN
    CREATE POLICY books_close_events_insert ON books_close_events
      FOR INSERT WITH CHECK (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'approver')
      );
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE ON books_close_waivers TO daftar_app, daftar_worker;
GRANT SELECT, INSERT ON books_close_events TO daftar_app, daftar_worker;
