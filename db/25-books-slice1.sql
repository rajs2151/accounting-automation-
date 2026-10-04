-- Slice 1: reserved-TLD emails; Layla as approver on books clients; one extraction per inbox item.

-- fiscal_year_start_month already on clients (db/22); ensure present for older volumes
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS fiscal_year_start_month int NOT NULL DEFAULT 1;

COMMENT ON COLUMN clients.fiscal_year_start_month IS
  'Month (1-12) when the company fiscal year starts. Voucher number series are per fiscal year. Separate from books_start_period.';

-- Keep newest extraction per inbox item before unique index
DELETE FROM books_extractions e
USING books_extractions newer
WHERE e.inbox_item_id IS NOT NULL
  AND e.inbox_item_id = newer.inbox_item_id
  AND e.created_at < newer.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS books_extractions_inbox_uidx
  ON books_extractions (inbox_item_id)
  WHERE inbox_item_id IS NOT NULL;

-- Reserved TLD emails for synthetic users
UPDATE users SET email = 'layla@arnibooks.test' WHERE id = '44444444-4444-4444-8444-444444444444';
UPDATE users SET email = 'omar@arnibooks.test' WHERE id = '55555555-5555-4555-8555-555555555555';
UPDATE users SET email = 'nina@arnibooks.test' WHERE id = '66666666-6666-4666-8666-666666666666';
UPDATE users SET email = 'books-a-only@arnibooks.test' WHERE id = 'e5000001-0000-4000-8000-000000000001';

UPDATE users SET role = 'approver'
WHERE id = '44444444-4444-4444-8444-444444444444';

-- Layla (approver) + Omar (preparer) on books clients. Nina stays Harbour-only (db/02);
-- do not grant her Desert Falcon — that breaks Stage G firm-pipeline isolation.
INSERT INTO user_client_access (user_id, client_id) VALUES
  ('44444444-4444-4444-8444-444444444444', 'e1000001-0000-4000-8000-000000000001'),
  ('44444444-4444-4444-8444-444444444444', 'e1000001-0000-4000-8000-000000000002'),
  ('44444444-4444-4444-8444-444444444444', 'e1000001-0000-4000-8000-000000000003'),
  ('55555555-5555-4555-8555-555555555555', 'e1000001-0000-4000-8000-000000000001'),
  ('55555555-5555-4555-8555-555555555555', 'e1000001-0000-4000-8000-000000000002'),
  ('55555555-5555-4555-8555-555555555555', 'e1000001-0000-4000-8000-000000000003')
ON CONFLICT DO NOTHING;
