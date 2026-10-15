-- Phase 1 seed: Stripe CSV profile, sample parties for Desert Falcon, books_start_period = May (Apr locked).

-- Stripe balance_history column map preset (global)
INSERT INTO books_source_profiles (id, client_id, issuer_key, doc_type, file_type, header_fingerprint, column_map, date_format)
VALUES (
  'e8000001-0000-4000-8000-000000000001',
  NULL,
  'stripe',
  'gateway_statement',
  'csv',
  'balance_history',
  '{
    "date": "Created (UTC)",
    "description": "Description",
    "debit": "Amount",
    "credit": null,
    "currency": "Currency",
    "reference": "id",
    "fee": "Fee",
    "net": "Net",
    "type": "Type",
    "sign_mode": "signed_amount"
  }'::jsonb,
  'yyyy-mm-dd'
)
ON CONFLICT (issuer_key, doc_type, file_type, header_fingerprint) DO UPDATE SET
  column_map = EXCLUDED.column_map,
  date_format = EXCLUDED.date_format;

-- Desert Falcon: books start = May 2026 (Apr LOCKED with history)
UPDATE clients c
SET books_start_period_id = p.id,
    trn = COALESCE(c.trn, '100000000000001'),
    default_iban = COALESCE(c.default_iban, 'AE070331234567890123456')
FROM books_periods p
WHERE c.id = 'e1000001-0000-4000-8000-000000000001'
  AND p.client_id = c.id
  AND p.label = 'May 2026';

UPDATE clients c
SET trn = COALESCE(c.trn, '100000000000002'),
    default_iban = COALESCE(c.default_iban, 'AE070331234567890123457')
WHERE c.id = 'e1000001-0000-4000-8000-000000000002';

UPDATE clients c
SET trn = COALESCE(c.trn, '100000000000003'),
    default_iban = COALESCE(c.default_iban, 'AE070331234567890123458')
WHERE c.id = 'e1000001-0000-4000-8000-000000000003';

-- Sample parties (Desert Falcon)
INSERT INTO books_parties (id, client_id, party_type, name, trn, country, emirate, zone, default_vat_code, payment_terms_days)
VALUES
  ('e9000001-0000-4000-8000-000000000001', 'e1000001-0000-4000-8000-000000000001',
   'customer', 'Oasis Retail LLC', '100123456700003', 'AE', 'Dubai', 'mainland', 'SR', 30),
  ('e9000001-0000-4000-8000-000000000002', 'e1000001-0000-4000-8000-000000000001',
   'supplier', 'Falaj Office Supplies LLC', '100123456700004', 'AE', 'Dubai', 'mainland', 'SR', 15),
  ('e9000001-0000-4000-8000-000000000003', 'e1000001-0000-4000-8000-000000000001',
   'supplier', 'Global Cloud Services Inc', NULL, 'US', NULL, NULL, 'RC_IN', 30)
ON CONFLICT (client_id, party_type, name) DO NOTHING;

-- Wire default accounts where COA v2 codes exist
UPDATE books_parties p
SET default_account_id = a.id
FROM books_accounts a
WHERE p.client_id = a.client_id
  AND p.id = 'e9000001-0000-4000-8000-000000000001'
  AND a.code = '1210';

UPDATE books_parties p
SET default_account_id = a.id
FROM books_accounts a
WHERE p.client_id = a.client_id
  AND p.id IN ('e9000001-0000-4000-8000-000000000002', 'e9000001-0000-4000-8000-000000000003')
  AND a.code = '2110';

-- Statement staging demos (Phase 1 e2e / screenshots) — stable IDs
-- 098 = balanced; 088 = dropped-row (running balance break on 2nd line)
INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
VALUES
 (
  'e7000001-0000-4000-8000-000000000099',
  'e1000001-0000-4000-8000-000000000001',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'synthetic/stmt-demo.csv',
  'stmt-demo.csv',
  'text/csv',
  100,
  '55555555-5555-4555-8555-555555555555'
 ),
 (
  'e7000001-0000-4000-8000-000000000089',
  'e1000001-0000-4000-8000-000000000001',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'synthetic/stmt-dropped.csv',
  'stmt-dropped.csv',
  'text/csv',
  100,
  '55555555-5555-4555-8555-555555555555'
 )
ON CONFLICT DO NOTHING;

INSERT INTO books_statement_extractions (
  id, client_id, file_id, account_label, iban, bank_name, currency,
  period_from, period_to,
  opening_balance_minor, closing_balance_minor, status, validation_flags
) VALUES
 (
  'e7000001-0000-4000-8000-000000000098',
  'e1000001-0000-4000-8000-000000000001',
  'e7000001-0000-4000-8000-000000000099',
  'AED current · Synthetic UAE Bank',
  'AE070331234567890123456',
  'Synthetic UAE Bank',
  'AED',
  '2026-05-01', '2026-05-31',
  100000,
  130000,
  'needs_review',
  '[]'::jsonb
 ),
 (
  'e7000001-0000-4000-8000-000000000088',
  'e1000001-0000-4000-8000-000000000001',
  'e7000001-0000-4000-8000-000000000089',
  'AED current · Synthetic UAE Bank (dropped row)',
  'AE070331234567890123456',
  'Synthetic UAE Bank (gap)',
  'AED',
  '2026-05-01', '2026-05-31',
  100000,
  130000,
  'needs_review',
  '["closing_mismatch"]'::jsonb
 )
ON CONFLICT DO NOTHING;

-- Keep account/IBAN/period columns fresh on re-seed
UPDATE books_statement_extractions SET
  account_label = 'AED current · Synthetic UAE Bank',
  iban = 'AE070331234567890123456',
  bank_name = 'Synthetic UAE Bank',
  period_from = '2026-05-01',
  period_to = '2026-05-31',
  opening_balance_minor = 100000,
  closing_balance_minor = 130000,
  validation_flags = '[]'::jsonb
WHERE id = 'e7000001-0000-4000-8000-000000000098';

UPDATE books_statement_extractions SET
  account_label = 'AED current · Synthetic UAE Bank (dropped row)',
  iban = 'AE070331234567890123456',
  bank_name = 'Synthetic UAE Bank (gap)',
  period_from = '2026-05-01',
  period_to = '2026-05-31',
  opening_balance_minor = 100000,
  closing_balance_minor = 130000,
  validation_flags = '["closing_mismatch"]'::jsonb
WHERE id = 'e7000001-0000-4000-8000-000000000088';

DELETE FROM books_statement_lines
WHERE statement_id IN (
  'e7000001-0000-4000-8000-000000000098',
  'e7000001-0000-4000-8000-000000000088'
);

INSERT INTO books_statement_lines (
  id, statement_id, client_id, line_date, description,
  debit_minor, credit_minor, running_balance_minor, currency, confidence, flags, sort_index
) VALUES
 -- Balanced: 1000 + 500 - 200 = 1300
 (
   'e7000001-0000-4000-8000-000000000097',
   'e7000001-0000-4000-8000-000000000098',
   'e1000001-0000-4000-8000-000000000001',
   '2026-05-05', 'CLIENT RECEIPT', 0, 50000, 150000, 'AED', 0.99, '{}', 0
 ),
 (
   'e7000001-0000-4000-8000-000000000096',
   'e7000001-0000-4000-8000-000000000098',
   'e1000001-0000-4000-8000-000000000001',
   '2026-05-10', 'OFFICE RENT', 20000, 0, 130000, 'AED', 0.99, '{}', 1
 ),
 -- Dropped row: second line claims running 1300 but true expected is 1500 (missing 200 DR)
 (
   'e7000001-0000-4000-8000-000000000087',
   'e7000001-0000-4000-8000-000000000088',
   'e1000001-0000-4000-8000-000000000001',
   '2026-05-05', 'CLIENT RECEIPT', 0, 50000, 150000, 'AED', 0.99, '{}', 0
 ),
 (
   'e7000001-0000-4000-8000-000000000086',
   'e7000001-0000-4000-8000-000000000088',
   'e1000001-0000-4000-8000-000000000001',
   '2026-05-12', 'CARD PAYMENT (after gap)', 0, 0, 130000, 'AED', 0.99, '{balance_break}', 1
 )
ON CONFLICT DO NOTHING;
