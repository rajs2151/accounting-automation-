-- VERIFY-S1: allow the `approver` role to write release packs / approvals / downloads.
-- Root cause: db/22 (and db/25) set Layla to role=approver for books dual-control, but
-- legacy Stage B RLS on release_packs / pack_approvals / download_events still only
-- permitted admin|accountant. Approver UPDATE on release_packs silently matched 0 rows
-- (USING failed); the following INSERT into pack_approvals then raised 42501.
-- Including approver here enables dual-control; it does not grant viewer write access.
-- Also revoke Nina's accidental Desert Falcon access from db/25 (legacy RLS isolation).

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
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (client_id IN (SELECT visible_client_ids()) AND app_role() IN (''admin'', ''accountant'', ''approver''))',
      tbl || '_insert', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (client_id IN (SELECT visible_client_ids()) AND app_role() IN (''admin'', ''accountant'', ''approver'')) WITH CHECK (client_id IN (SELECT visible_client_ids()) AND app_role() IN (''admin'', ''accountant'', ''approver''))',
      tbl || '_update', tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (client_id IN (SELECT visible_client_ids()) AND app_role() IN (''admin'', ''accountant'', ''approver''))',
      tbl || '_delete', tbl
    );
  END LOOP;
END
$$;

-- Nina (viewer) must remain Harbour Cafe only for Stage G firm-pipeline isolation.
DELETE FROM user_client_access
WHERE user_id = '66666666-6666-4666-8666-666666666666'
  AND client_id = 'e1000001-0000-4000-8000-000000000001';
