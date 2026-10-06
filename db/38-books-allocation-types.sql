-- TALLY-1: bill-wise allocation types on receipts/payments (Tally: Agst Ref / Advance / On Account).
-- Additive + idempotent.
--
--  * books_party_credits: one row per receipt/payment part that was NOT matched to a bill
--    (advance = unbilled prepayment; on_account = paid, bill not yet identified). Traceable per
--    settlement document so it can be applied to a later invoice/bill.
--  * books_allocations.allocation_type: agst_ref (existing behaviour) | advance | on_account.
--    Rows with open_item_id NULL record the creation of a credit by a receipt/payment;
--    rows with open_item_id + party_credit_id record a credit applied to a bill.
--  * COA 1250 Supplier advances (asset) for supplier prepayments (customer side uses 2320).
--
-- TODO(owner decision pending): VAT on customer advances is NOT decided. Nothing here posts or
-- computes VAT on advances; credits carry vat_policy_pending = true so they can be found later.

-- ---------------------------------------------------------------------------
-- COA: 1250 Supplier advances
-- ---------------------------------------------------------------------------
INSERT INTO books_coa_template (
  code, name, account_type, parent_code, is_postable, normal_balance,
  is_bank, is_ar, is_ap, is_vat_control, is_control, is_contra, sub_type,
  cash_flow_class, statement_line, note_group, default_vat_code, sort_order
) VALUES (
  '1250', 'Supplier advances', 'asset', '1200', true, 'debit',
  false, false, false, false, false, false, 'advance',
  'operating', 'BS_current_assets', 'receivables', NULL, 1250
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO books_accounts (
  client_id, code, name, account_type, parent_id, is_postable, normal_balance,
  is_ar, is_ap, is_vat_control, is_bank, is_control, is_contra, sub_type,
  cash_flow_class, statement_line, note_group, default_vat_code, template_code
)
SELECT p.client_id, t.code, t.name, t.account_type, p.id, t.is_postable, t.normal_balance,
       t.is_ar, t.is_ap, t.is_vat_control, t.is_bank, t.is_control, t.is_contra, t.sub_type,
       t.cash_flow_class, t.statement_line, t.note_group, t.default_vat_code, t.code
FROM books_coa_template t
JOIN books_accounts p ON p.code = t.parent_code
WHERE t.code = '1250'
ON CONFLICT (client_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Per-settlement unapplied credits (advance / on account)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS books_party_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  party_id uuid NOT NULL REFERENCES books_parties(id),
  side text NOT NULL CHECK (side IN ('AR', 'AP')),
  credit_type text NOT NULL CHECK (credit_type IN ('advance', 'on_account')),
  settlement_document_id uuid NOT NULL REFERENCES books_documents(id),
  settlement_journal_id uuid NOT NULL REFERENCES books_journal_entries(id),
  currency char(3) NOT NULL DEFAULT 'AED',
  fx_rate_scaled bigint NOT NULL DEFAULT 100000000,
  original_minor bigint NOT NULL CHECK (original_minor > 0),
  aed_minor bigint NOT NULL CHECK (aed_minor >= 0),
  open_original_minor bigint NOT NULL CHECK (open_original_minor >= 0),
  open_aed_minor bigint NOT NULL CHECK (open_aed_minor >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'closed')),
  -- TODO(owner): VAT on advances undecided — flag only, never a VAT line.
  vat_policy_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (open_original_minor <= original_minor)
);

CREATE INDEX IF NOT EXISTS books_party_credits_party_idx
  ON books_party_credits (client_id, party_id, side, credit_type, status, created_at);
CREATE INDEX IF NOT EXISTS books_party_credits_settlement_idx
  ON books_party_credits (settlement_document_id);

-- ---------------------------------------------------------------------------
-- Allocation type on books_allocations
-- ---------------------------------------------------------------------------
ALTER TABLE books_allocations
  ADD COLUMN IF NOT EXISTS allocation_type text NOT NULL DEFAULT 'agst_ref';
ALTER TABLE books_allocations
  ADD COLUMN IF NOT EXISTS party_credit_id uuid REFERENCES books_party_credits(id);
ALTER TABLE books_allocations ALTER COLUMN open_item_id DROP NOT NULL;

ALTER TABLE books_allocations DROP CONSTRAINT IF EXISTS books_allocations_type_check;
ALTER TABLE books_allocations ADD CONSTRAINT books_allocations_type_check CHECK (
  (allocation_type = 'agst_ref' AND open_item_id IS NOT NULL AND party_credit_id IS NULL)
  OR (allocation_type IN ('advance', 'on_account') AND party_credit_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS books_allocations_credit_idx
  ON books_allocations (party_credit_id) WHERE party_credit_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill (dev/demo DBs): receipts posted before this migration left their unallocated
-- remainder only in books_party_advances. Create one 'advance' credit per such receipt,
-- then consume them oldest-first so each party's open total equals its running balance.
-- Allocation rows written by the old allocatePartyAdvance ('Advance allocation' journal
-- documents) are re-typed as 'advance' and linked to the credits they consumed.
-- Runs only when no credits exist yet (idempotent).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  rcp record;
  cr record;
  app record;
  remaining bigint;
  take bigint;
  take_aed bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM books_party_credits) THEN
    RETURN;
  END IF;

  FOR rcp IN
    SELECT d.id, d.client_id, d.party_id, d.currency, d.fx_rate_scaled, d.journal_entry_id,
           d.original_total_minor
             - COALESCE((SELECT SUM(a.allocated_original_minor) FROM books_allocations a
                         WHERE a.settlement_document_id = d.id), 0) AS unalloc
    FROM books_documents d
    WHERE d.doc_type = 'receipt' AND d.status = 'posted' AND d.deleted_at IS NULL
      AND COALESCE(d.voucher_type, 'Receipt') = 'Receipt'
      AND d.party_id IS NOT NULL AND d.journal_entry_id IS NOT NULL
    ORDER BY d.issue_date, d.created_at
  LOOP
    IF rcp.unalloc > 0 THEN
      INSERT INTO books_party_credits (
        client_id, party_id, side, credit_type, settlement_document_id, settlement_journal_id,
        currency, fx_rate_scaled, original_minor, aed_minor, open_original_minor, open_aed_minor,
        status, vat_policy_pending
      ) VALUES (
        rcp.client_id, rcp.party_id, 'AR', 'advance', rcp.id, rcp.journal_entry_id,
        rcp.currency, rcp.fx_rate_scaled, rcp.unalloc,
        (rcp.unalloc * rcp.fx_rate_scaled + 50000000) / 100000000,
        rcp.unalloc, (rcp.unalloc * rcp.fx_rate_scaled + 50000000) / 100000000,
        'open', true
      );
    END IF;
  END LOOP;

  -- Old advance applications, oldest first, consume credits FIFO.
  FOR app IN
    SELECT a.id, a.client_id, d.party_id, d.currency, a.allocated_original_minor
    FROM books_allocations a
    JOIN books_documents d ON d.id = a.settlement_document_id
    WHERE d.doc_type = 'receipt' AND d.voucher_type = 'Journal'
      AND d.memo = 'Advance allocation' AND a.allocation_type = 'agst_ref'
    ORDER BY a.created_at
  LOOP
    remaining := app.allocated_original_minor;
    FOR cr IN
      SELECT id, open_original_minor, open_aed_minor FROM books_party_credits
      WHERE client_id = app.client_id AND party_id = app.party_id AND currency = app.currency
        AND side = 'AR' AND credit_type = 'advance' AND open_original_minor > 0
      ORDER BY created_at, id
    LOOP
      EXIT WHEN remaining <= 0;
      take := LEAST(remaining, cr.open_original_minor);
      take_aed := CASE WHEN take = cr.open_original_minor THEN cr.open_aed_minor
                       ELSE LEAST(cr.open_aed_minor, take * cr.open_aed_minor / cr.open_original_minor) END;
      UPDATE books_party_credits SET
        open_original_minor = open_original_minor - take,
        open_aed_minor = open_aed_minor - take_aed,
        status = CASE WHEN open_original_minor - take = 0 THEN 'closed' ELSE 'partial' END,
        updated_at = now()
      WHERE id = cr.id;
      -- Link the first consumed credit (old rows were single allocations).
      UPDATE books_allocations SET allocation_type = 'advance', party_credit_id = cr.id
      WHERE id = app.id AND party_credit_id IS NULL;
      remaining := remaining - take;
    END LOOP;
  END LOOP;
END $$;

-- Creation rows for backfilled credits (open_item_id NULL = "this receipt created the credit").
INSERT INTO books_allocations (
  client_id, settlement_document_id, settlement_journal_id, open_item_id,
  allocated_original_minor, allocated_aed_minor, fx_gain_loss_aed_minor,
  allocation_type, party_credit_id
)
SELECT c.client_id, c.settlement_document_id, c.settlement_journal_id, NULL,
       c.original_minor, c.aed_minor, 0, c.credit_type, c.id
FROM books_party_credits c
WHERE c.aed_minor > 0
  AND NOT EXISTS (
    SELECT 1 FROM books_allocations a
    WHERE a.party_credit_id = c.id AND a.open_item_id IS NULL
  );

-- ---------------------------------------------------------------------------
-- RLS + grants (same pattern as db/23)
-- ---------------------------------------------------------------------------
ALTER TABLE books_party_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE books_party_credits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS books_party_credits_read ON books_party_credits;
DROP POLICY IF EXISTS books_party_credits_insert ON books_party_credits;
DROP POLICY IF EXISTS books_party_credits_update ON books_party_credits;
DROP POLICY IF EXISTS books_party_credits_delete ON books_party_credits;
CREATE POLICY books_party_credits_read ON books_party_credits FOR SELECT USING (
  client_id IN (SELECT visible_client_ids())
);
CREATE POLICY books_party_credits_insert ON books_party_credits FOR INSERT WITH CHECK (
  client_id IN (SELECT visible_client_ids())
  AND app_role() IN ('admin', 'accountant', 'approver')
);
CREATE POLICY books_party_credits_update ON books_party_credits FOR UPDATE USING (
  client_id IN (SELECT visible_client_ids())
) WITH CHECK (
  client_id IN (SELECT visible_client_ids())
  AND app_role() IN ('admin', 'accountant', 'approver')
);
CREATE POLICY books_party_credits_delete ON books_party_credits FOR DELETE USING (
  client_id IN (SELECT visible_client_ids())
  AND app_role() IN ('admin', 'accountant', 'approver')
);

GRANT SELECT, INSERT, UPDATE, DELETE ON books_party_credits TO daftar_app, daftar_worker;
