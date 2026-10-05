-- File hashes are unique per company, not globally. The global UNIQUE (sha256) from db/23 made the same file
-- uploaded to a second company fail: the duplicate lookup runs under RLS (cannot see the other company's file),
-- so the insert hit the hidden global constraint and the upload returned a 500.
-- NULLS NOT DISTINCT keeps one copy per hash in the Unassigned inbox (client_id NULL) too.

ALTER TABLE books_files DROP CONSTRAINT IF EXISTS books_files_sha256_key;
CREATE UNIQUE INDEX IF NOT EXISTS books_files_client_sha256_uidx
  ON books_files (client_id, sha256) NULLS NOT DISTINCT;
