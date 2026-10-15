-- PYTEST-0: FORCE RLS on reference / sequence tables that were created without it.
-- Additive and idempotent. Strengthens security (does not weaken any policy).
-- Root cause: test_forced_rls_and_set_local_is_transaction_scoped asserts every public
-- table has relrowsecurity + relforcerowsecurity; books_coa_template, books_ref_sequences,
-- books_vat_codes, and books_free_zone_emirate were missing both.

-- Global read-only reference catalogs (no client_id)
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['books_coa_template', 'books_vat_codes', 'books_free_zone_emirate']
  LOOP
    IF to_regclass(tbl) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_read', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (true)',
      tbl || '_read', tbl
    );
  END LOOP;
END
$$;

-- Per-tenant sequence table (mirrors books_entry_sequences)
DO $$
BEGIN
  IF to_regclass('books_ref_sequences') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE books_ref_sequences ENABLE ROW LEVEL SECURITY;
  ALTER TABLE books_ref_sequences FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS books_ref_sequences_all ON books_ref_sequences;
  DROP POLICY IF EXISTS books_ref_sequences_read ON books_ref_sequences;
  CREATE POLICY books_ref_sequences_all ON books_ref_sequences FOR ALL
    USING (client_id IN (SELECT visible_client_ids()) AND app_role() IN ('admin', 'accountant'))
    WITH CHECK (client_id IN (SELECT visible_client_ids()) AND app_role() IN ('admin', 'accountant'));
  CREATE POLICY books_ref_sequences_read ON books_ref_sequences FOR SELECT
    USING (client_id IN (SELECT visible_client_ids()));
END
$$;
