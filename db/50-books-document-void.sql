-- P2B-1: void = reversal for posted documents (sales invoices, purchase bills, credit/debit notes).
-- The posted journal is never edited: voiding posts a linked reversal entry (dual control via
-- reverseBooksJournal) and records who/why here. Additive + idempotent.

ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS voided_by uuid REFERENCES users(id);
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS void_reason text;
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS void_journal_id uuid REFERENCES books_journal_entries(id);

-- A posted document that is void must carry its reversal + reason (drafts soft-deleted as 'void'
-- by C1-3 have no journal and stay unaffected).
ALTER TABLE books_documents DROP CONSTRAINT IF EXISTS books_documents_void_reversal_check;
ALTER TABLE books_documents ADD CONSTRAINT books_documents_void_reversal_check CHECK (
  voided_at IS NULL
  OR (status = 'void' AND void_journal_id IS NOT NULL AND voided_by IS NOT NULL
      AND COALESCE(btrim(void_reason), '') <> '')
);
