INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
VALUES (
  'e7000001-0000-4000-8000-000000000099',
  'e1000001-0000-4000-8000-000000000001',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'synthetic/stmt-demo.csv',
  'stmt-demo.csv',
  'text/csv',
  100,
  '55555555-5555-4555-8555-555555555555'
)
ON CONFLICT DO NOTHING;

INSERT INTO books_statement_extractions (
  id, client_id, file_id, bank_name, currency,
  opening_balance_minor, closing_balance_minor, status, validation_flags
) VALUES (
  'e7000001-0000-4000-8000-000000000098',
  'e1000001-0000-4000-8000-000000000001',
  'e7000001-0000-4000-8000-000000000099',
  'Synthetic UAE Bank',
  'AED',
  100000,
  130000,
  'needs_review',
  '["demo"]'::jsonb
)
ON CONFLICT DO NOTHING;

DELETE FROM books_statement_lines
WHERE statement_id = 'e7000001-0000-4000-8000-000000000098';

INSERT INTO books_statement_lines (
  id, statement_id, client_id, line_date, description,
  debit_minor, credit_minor, running_balance_minor, currency, confidence, flags, sort_index
) VALUES
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
 );
