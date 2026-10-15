-- Books seed clients + Desert Falcon golden journals (schema from 16-books.sql).
-- Full UAE SME COA template + JE numbering applied in 18-books-phase0.sql.

INSERT INTO clients (id, firm_id, name, trn, default_currency, is_synthetic) VALUES
  (
    'e1000001-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'Desert Falcon Services FZE',
    '100000000000001',
    'AED',
    true
  ),
  (
    'e1000001-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    'Gulf Crest Trading LLC',
    '100000000000002',
    'AED',
    true
  ),
  (
    'e1000001-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111',
    'Palm Grove Properties LLC',
    '100000000000003',
    'AED',
    true
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  trn = EXCLUDED.trn,
  is_synthetic = true;

-- RLS probe user: Desert Falcon (A) only — must not see Gulf Crest (B).
INSERT INTO users (id, firm_id, email, name, role) VALUES
  (
    'e5000001-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'books-a-only@arnibooks.test',
    'Books A-Only',
    'accountant'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_client_access (user_id, client_id) VALUES
  ('44444444-4444-4444-8444-444444444444', 'e1000001-0000-4000-8000-000000000001'),
  ('55555555-5555-4555-8555-555555555555', 'e1000001-0000-4000-8000-000000000001'),
  ('44444444-4444-4444-8444-444444444444', 'e1000001-0000-4000-8000-000000000002'),
  ('55555555-5555-4555-8555-555555555555', 'e1000001-0000-4000-8000-000000000002'),
  ('44444444-4444-4444-8444-444444444444', 'e1000001-0000-4000-8000-000000000003'),
  ('55555555-5555-4555-8555-555555555555', 'e1000001-0000-4000-8000-000000000003'),
  ('e5000001-0000-4000-8000-000000000001', 'e1000001-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;

INSERT INTO books_periods (id, client_id, label, period_start, period_end, status) VALUES
  (
    'e2000001-0000-4000-8000-000000000001',
    'e1000001-0000-4000-8000-000000000001',
    '2026-Q2',
    '2026-04-01',
    '2026-06-30',
    'OPEN'
  ),
  (
    'e2000001-0000-4000-8000-000000000002',
    'e1000001-0000-4000-8000-000000000002',
    '2026-Q2',
    '2026-04-01',
    '2026-06-30',
    'OPEN'
  ),
  (
    'e2000001-0000-4000-8000-000000000003',
    'e1000001-0000-4000-8000-000000000003',
    '2026-Q2',
    '2026-04-01',
    '2026-06-30',
    'OPEN'
  )
ON CONFLICT (id) DO NOTHING;

-- Leaf accounts for golden journals (v1 codes; remapped to COA v2 in 20-books-coa-v2.sql).
INSERT INTO books_accounts (
  id, client_id, code, name, account_type, is_bank, is_ar, is_ap, is_vat_control, active
) VALUES
  ('e3000001-0000-4000-8000-000000000001', 'e1000001-0000-4000-8000-000000000001', '1001', 'Operating bank AED', 'asset', true, false, false, false, true),
  ('e3000001-0000-4000-8000-000000000002', 'e1000001-0000-4000-8000-000000000001', '1101', 'Trade receivables', 'asset', false, true, false, false, true),
  ('e3000001-0000-4000-8000-000000000004', 'e1000001-0000-4000-8000-000000000001', '2101', 'VAT output', 'liability', false, false, false, true, true),
  ('e3000001-0000-4000-8000-000000000006', 'e1000001-0000-4000-8000-000000000001', '3001', 'Owner capital', 'equity', false, false, false, false, true),
  ('e3000001-0000-4000-8000-000000000007', 'e1000001-0000-4000-8000-000000000001', '4001', 'Service revenue', 'income', false, false, false, false, true),
  ('e3000001-0000-4000-8000-000000000008', 'e1000001-0000-4000-8000-000000000001', '5107', 'General & admin', 'expense', false, false, false, false, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO books_journal_entries (
  id, client_id, period_id, memo, entry_date, status, content_hash, created_by
) VALUES
  (
    'e4000001-0000-4000-8000-000000000001',
    'e1000001-0000-4000-8000-000000000001',
    'e2000001-0000-4000-8000-000000000001',
    'Opening equity',
    '2026-04-01',
    'draft',
    'seed-opening',
    '55555555-5555-4555-8555-555555555555'
  ),
  (
    'e4000001-0000-4000-8000-000000000002',
    'e1000001-0000-4000-8000-000000000001',
    'e2000001-0000-4000-8000-000000000001',
    'April service invoice',
    '2026-04-10',
    'draft',
    'seed-sale',
    '55555555-5555-4555-8555-555555555555'
  ),
  (
    'e4000001-0000-4000-8000-000000000003',
    'e1000001-0000-4000-8000-000000000001',
    'e2000001-0000-4000-8000-000000000001',
    'Office expense',
    '2026-04-15',
    'draft',
    'seed-expense',
    '55555555-5555-4555-8555-555555555555'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO books_journal_lines (
  id, entry_id, client_id, account_id, debit_minor, credit_minor, currency, aed_minor, line_memo
)
SELECT v.id, v.entry_id, v.client_id, v.account_id, v.debit_minor, v.credit_minor, v.currency, v.aed_minor, v.line_memo
FROM (
  VALUES
    ('e5000001-0000-4000-8000-000000000001'::uuid, 'e4000001-0000-4000-8000-000000000001'::uuid, 'e1000001-0000-4000-8000-000000000001'::uuid, 'e3000001-0000-4000-8000-000000000001'::uuid, 100000::bigint, 0::bigint, 'AED', 100000::bigint, 'Opening cash'),
    ('e5000001-0000-4000-8000-000000000002', 'e4000001-0000-4000-8000-000000000001', 'e1000001-0000-4000-8000-000000000001', 'e3000001-0000-4000-8000-000000000006', 0, 100000, 'AED', 100000, 'Opening equity'),
    ('e5000001-0000-4000-8000-000000000003', 'e4000001-0000-4000-8000-000000000002', 'e1000001-0000-4000-8000-000000000001', 'e3000001-0000-4000-8000-000000000002', 10500, 0, 'AED', 10500, 'AR'),
    ('e5000001-0000-4000-8000-000000000004', 'e4000001-0000-4000-8000-000000000002', 'e1000001-0000-4000-8000-000000000001', 'e3000001-0000-4000-8000-000000000007', 0, 10000, 'AED', 10000, 'Revenue'),
    ('e5000001-0000-4000-8000-000000000005', 'e4000001-0000-4000-8000-000000000002', 'e1000001-0000-4000-8000-000000000001', 'e3000001-0000-4000-8000-000000000004', 0, 500, 'AED', 500, 'VAT 5%'),
    ('e5000001-0000-4000-8000-000000000006', 'e4000001-0000-4000-8000-000000000003', 'e1000001-0000-4000-8000-000000000001', 'e3000001-0000-4000-8000-000000000008', 2000, 0, 'AED', 2000, 'Expense'),
    ('e5000001-0000-4000-8000-000000000007', 'e4000001-0000-4000-8000-000000000003', 'e1000001-0000-4000-8000-000000000001', 'e3000001-0000-4000-8000-000000000001', 0, 2000, 'AED', 2000, 'Bank payment')
) AS v(id, entry_id, client_id, account_id, debit_minor, credit_minor, currency, aed_minor, line_memo)
WHERE NOT EXISTS (SELECT 1 FROM books_journal_lines existing WHERE existing.id = v.id);

UPDATE books_journal_entries
SET status = 'posted', posted_at = entry_date::timestamptz
WHERE id IN (
  'e4000001-0000-4000-8000-000000000001',
  'e4000001-0000-4000-8000-000000000002',
  'e4000001-0000-4000-8000-000000000003'
)
AND status = 'draft';

INSERT INTO books_audit_events (client_id, actor, action, entity, entity_id, after_json, source)
SELECT
  'e1000001-0000-4000-8000-000000000001',
  '55555555-5555-4555-8555-555555555555',
  'seed_post',
  'books_journal_entry',
  id,
  jsonb_build_object('memo', memo, 'status', status),
  'seed'
FROM books_journal_entries
WHERE client_id = 'e1000001-0000-4000-8000-000000000001'
  AND id IN (
    'e4000001-0000-4000-8000-000000000001',
    'e4000001-0000-4000-8000-000000000002',
    'e4000001-0000-4000-8000-000000000003'
  )
  AND NOT EXISTS (
    SELECT 1 FROM books_audit_events a
    WHERE a.entity_id = books_journal_entries.id AND a.action = 'seed_post'
  );
