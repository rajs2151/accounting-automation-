-- Phase 1 review (2nd round): Desert Falcon May AR open item + close-waiver dual-control columns.
-- Does NOT reverse posted journals — attaches a sales invoice + open item to the existing May consulting JV.
-- Additive + idempotent.

-- ---------------------------------------------------------------------------
-- Close waivers: per-account, request → approve (dual control)
-- ---------------------------------------------------------------------------
ALTER TABLE books_close_waivers
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES books_accounts(id);

ALTER TABLE books_close_waivers
  ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES users(id);

ALTER TABLE books_close_waivers
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'books_close_waivers_status_chk'
  ) THEN
    ALTER TABLE books_close_waivers
      ADD CONSTRAINT books_close_waivers_status_chk
      CHECK (status IN ('pending', 'active'));
  END IF;
END $$;

-- Replace unique (client, period, gate) with per-account uniqueness.
ALTER TABLE books_close_waivers
  DROP CONSTRAINT IF EXISTS books_close_waivers_client_id_period_id_gate_key_key;

DROP INDEX IF EXISTS books_close_waivers_uidx;
CREATE UNIQUE INDEX books_close_waivers_uidx
  ON books_close_waivers (
    client_id,
    period_id,
    gate_key,
    COALESCE(account_id, '00000000-0000-0000-0000-000000000000')
  );

COMMENT ON COLUMN books_close_waivers.account_id IS
  'Optional: waive a specific bank/card account under statements/recon gates.';
COMMENT ON COLUMN books_close_waivers.status IS
  'pending = requested by preparer; active = approved by a different approver/admin.';

-- Preparers may request (pending); only approver/admin may set active (confirm).
DROP POLICY IF EXISTS books_close_waivers_insert ON books_close_waivers;
CREATE POLICY books_close_waivers_insert ON books_close_waivers
  FOR INSERT WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND app_role() IN ('admin', 'approver', 'accountant')
    AND (
      COALESCE(status, 'active') = 'pending'
      OR app_role() IN ('admin', 'approver')
    )
  );

DROP POLICY IF EXISTS books_close_waivers_update ON books_close_waivers;
CREATE POLICY books_close_waivers_update ON books_close_waivers
  FOR UPDATE USING (
    client_id IN (SELECT visible_client_ids())
    AND (
      -- Requester may refresh a pending request
      (COALESCE(status, 'active') = 'pending' AND app_role() IN ('admin', 'approver', 'accountant'))
      OR app_role() IN ('admin', 'approver')
    )
  )
  WITH CHECK (
    client_id IN (SELECT visible_client_ids())
    AND (
      (COALESCE(status, 'active') = 'pending' AND app_role() IN ('admin', 'approver', 'accountant'))
      OR (
        COALESCE(status, 'active') = 'active'
        AND app_role() IN ('admin', 'approver')
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Desert Falcon: link May consulting journal (e400…010) to invoice + open AR
-- GL unchanged (still Dr 1210 21000); open items become AED 210.00.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  desert uuid := 'e1000001-0000-4000-8000-000000000001';
  omar uuid := '55555555-5555-4555-8555-555555555555';
  layla uuid := '44444444-4444-4444-8444-444444444444';
  party uuid := 'e9000001-0000-4000-8000-000000000001';
  je uuid := 'e4000001-0000-4000-8000-000000000010';
  doc uuid := 'e6000001-0000-4000-8000-000000000010';
  oi uuid := 'e6100001-0000-4000-8000-000000000010';
  rev uuid;
  vat_acct uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM books_journal_entries WHERE id = je AND client_id = desert) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM books_open_items WHERE journal_entry_id = je) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM books_parties WHERE id = party) THEN
    RETURN;
  END IF;

  SELECT id INTO rev FROM books_accounts WHERE client_id = desert AND code = '4100';
  SELECT id INTO vat_acct FROM books_accounts WHERE client_id = desert AND code = '2210';

  INSERT INTO books_documents (
    id, client_id, doc_type, doc_kind, status, voucher_type, document_number, party_id,
    issue_date, due_date, currency, fx_rate_scaled,
    original_total_minor, aed_total_minor, net_minor, vat_minor, gross_minor,
    memo, journal_entry_id, created_by, approved_by
  ) VALUES (
    doc, desert, 'sales_invoice', 'customer', 'posted', 'Sales', 'INV-SEED-MAY-001', party,
    '2026-05-05', '2026-06-04', 'AED', 100000000,
    21000, 21000, 20000, 1000, 21000,
    'May consulting invoice (seed open-item backfill)', je, omar, layla
  )
  ON CONFLICT DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM books_documents WHERE id = doc) THEN
    -- Dedupe unique may have blocked; find by journal link
    SELECT id INTO doc FROM books_documents WHERE journal_entry_id = je AND client_id = desert LIMIT 1;
  END IF;

  IF doc IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM books_document_lines WHERE document_id = doc) THEN
    INSERT INTO books_document_lines (
      document_id, client_id, line_no, description, quantity_scaled, unit_price_minor,
      line_kind, account_id, vat_code, net_minor, vat_minor, gross_minor, currency, aed_minor
    ) VALUES
      (doc, desert, 1, 'Consulting', 1000, 20000, 'revenue', rev, 'SR', 20000, 1000, 21000, 'AED', 21000);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM books_open_items WHERE id = oi) THEN
    INSERT INTO books_open_items (
      id, client_id, party_id, document_id, journal_entry_id, side, currency,
      original_minor, aed_original_minor, open_original_minor, open_aed_minor, fx_rate_scaled, status
    ) VALUES (
      oi, desert, party, doc, je, 'AR', 'AED',
      21000, 21000, 21000, 21000, 100000000, 'open'
    );
  END IF;
  -- Do not UPDATE the posted journal (immutable trigger).
END $$;
