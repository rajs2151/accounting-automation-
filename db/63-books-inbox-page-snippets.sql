-- Multi-receipt PDF snippets: inbox children share file_id with page ranges.
ALTER TABLE books_inbox_items
  ADD COLUMN IF NOT EXISTS parent_inbox_item_id uuid REFERENCES books_inbox_items(id),
  ADD COLUMN IF NOT EXISTS page_start int,
  ADD COLUMN IF NOT EXISTS page_end int;

ALTER TABLE books_inbox_items DROP CONSTRAINT IF EXISTS books_inbox_items_page_range_check;
ALTER TABLE books_inbox_items ADD CONSTRAINT books_inbox_items_page_range_check CHECK (
  (page_start IS NULL AND page_end IS NULL)
  OR (
    page_start IS NOT NULL AND page_end IS NOT NULL
    AND page_start >= 1 AND page_end >= page_start
    AND page_end <= 500
  )
);

ALTER TABLE books_inbox_items DROP CONSTRAINT IF EXISTS books_inbox_items_parent_page_check;
ALTER TABLE books_inbox_items ADD CONSTRAINT books_inbox_items_parent_page_check CHECK (
  (parent_inbox_item_id IS NULL AND page_start IS NULL)
  OR (parent_inbox_item_id IS NOT NULL AND page_start IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS books_inbox_parent_idx
  ON books_inbox_items (parent_inbox_item_id)
  WHERE parent_inbox_item_id IS NOT NULL;

COMMENT ON COLUMN books_inbox_items.parent_inbox_item_id IS
  'When set, this row is a page-range snippet of the parent upload; shares file_id.';
COMMENT ON COLUMN books_inbox_items.page_start IS
  '1-based inclusive start page within the shared PDF (snippet children only).';
COMMENT ON COLUMN books_inbox_items.page_end IS
  '1-based inclusive end page within the shared PDF (snippet children only).';

ALTER TABLE books_documents
  ADD COLUMN IF NOT EXISTS page_start int,
  ADD COLUMN IF NOT EXISTS page_end int;

ALTER TABLE books_documents DROP CONSTRAINT IF EXISTS books_documents_page_range_check;
ALTER TABLE books_documents ADD CONSTRAINT books_documents_page_range_check CHECK (
  (page_start IS NULL AND page_end IS NULL)
  OR (
    page_start IS NOT NULL AND page_end IS NOT NULL
    AND page_start >= 1 AND page_end >= page_start
    AND page_end <= 500
  )
);
