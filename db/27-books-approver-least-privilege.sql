-- VERIFY-S1-FIX1: least privilege for approver on Stage B release tables.
-- db/26 correctly added approver so Layla can release, but also granted
-- INSERT/UPDATE/DELETE on all three tables. Approver must not delete or
-- mutate approval / download audit rows (dual-control trail).
-- This migration is additive and idempotent; it does not delete data.
--
-- Restores admin|accountant write rights exactly as in db/06-release-packs.sql
-- lines 67–78 (pre-db/26). Approver gets only:
--   release_packs     → UPDATE
--   pack_approvals    → INSERT
--   download_events   → INSERT

DO $$
DECLARE
  tbl text;
  pol text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['release_packs', 'pack_approvals', 'download_events']
  LOOP
    IF to_regclass(tbl) IS NULL THEN
      CONTINUE;
    END IF;
    FOREACH pol IN ARRAY ARRAY[tbl || '_insert', tbl || '_update', tbl || '_delete']
    LOOP
      IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = tbl AND policyname = pol
      ) THEN
        EXECUTE format('DROP POLICY %I ON %I', pol, tbl);
      END IF;
    END LOOP;
  END LOOP;

  -- release_packs: preparers create; approver may only flip status (UPDATE).
  IF to_regclass('release_packs') IS NOT NULL THEN
    CREATE POLICY release_packs_insert ON release_packs
      FOR INSERT WITH CHECK (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant')
      );
    CREATE POLICY release_packs_update ON release_packs
      FOR UPDATE
      USING (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant', 'approver')
      )
      WITH CHECK (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant', 'approver')
      );
    CREATE POLICY release_packs_delete ON release_packs
      FOR DELETE USING (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant')
      );
  END IF;

  -- pack_approvals: approver inserts the approval row; no UPDATE/DELETE.
  IF to_regclass('pack_approvals') IS NOT NULL THEN
    CREATE POLICY pack_approvals_insert ON pack_approvals
      FOR INSERT WITH CHECK (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant', 'approver')
      );
    CREATE POLICY pack_approvals_update ON pack_approvals
      FOR UPDATE
      USING (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant')
      )
      WITH CHECK (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant')
      );
    CREATE POLICY pack_approvals_delete ON pack_approvals
      FOR DELETE USING (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant')
      );
  END IF;

  -- download_events: append-only for approver; admin|accountant retain full write.
  IF to_regclass('download_events') IS NOT NULL THEN
    CREATE POLICY download_events_insert ON download_events
      FOR INSERT WITH CHECK (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant', 'approver')
      );
    CREATE POLICY download_events_update ON download_events
      FOR UPDATE
      USING (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant')
      )
      WITH CHECK (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant')
      );
    CREATE POLICY download_events_delete ON download_events
      FOR DELETE USING (
        client_id IN (SELECT visible_client_ids())
        AND app_role() IN ('admin', 'accountant')
      );
  END IF;
END
$$;
