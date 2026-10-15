-- C polish: inbox "Review later" status (soft park without failing extraction).
ALTER TABLE books_inbox_items DROP CONSTRAINT IF EXISTS books_inbox_items_status_check;
ALTER TABLE books_inbox_items
  ADD CONSTRAINT books_inbox_items_status_check
  CHECK (status IN (
    'queued', 'extracting', 'needs_review', 'review_later', 'ready', 'confirmed', 'failed', 'routed'
  ));
