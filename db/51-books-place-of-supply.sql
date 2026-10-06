-- P2B-2: place of supply (emirate) recorded on every sales/purchase document for VAT 201 grouping.
-- Snapshot from the party master at create and again at approve (frozen once posted); a document-level
-- override needs a reason and is audited. Notes inherit from their original. Additive + idempotent.

ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS place_of_supply text;
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS place_of_supply_source text;
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS place_of_supply_reason text;

ALTER TABLE books_documents DROP CONSTRAINT IF EXISTS books_documents_pos_check;
ALTER TABLE books_documents ADD CONSTRAINT books_documents_pos_check CHECK (
  place_of_supply IS NULL OR place_of_supply IN (
    'Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah',
    'OUTSIDE_UAE'
  )
);
ALTER TABLE books_documents DROP CONSTRAINT IF EXISTS books_documents_pos_source_check;
ALTER TABLE books_documents ADD CONSTRAINT books_documents_pos_source_check CHECK (
  place_of_supply_source IS NULL
  OR (place_of_supply_source IN ('party', 'original') AND place_of_supply IS NOT NULL)
  OR (place_of_supply_source = 'override' AND place_of_supply IS NOT NULL
      AND COALESCE(btrim(place_of_supply_reason), '') <> '')
  OR (place_of_supply_source = 'missing' AND place_of_supply IS NULL)
);

-- Backfill existing sales/purchase documents from the party master (exact canonical names only).
UPDATE books_documents d SET
  place_of_supply = CASE
    WHEN p.country <> 'AE' THEN 'OUTSIDE_UAE'
    WHEN p.emirate IN ('Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah')
      THEN p.emirate
    ELSE NULL
  END,
  place_of_supply_source = CASE
    WHEN p.country <> 'AE' THEN 'party'
    WHEN p.emirate IN ('Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah')
      THEN 'party'
    ELSE 'missing'
  END
FROM books_parties p
WHERE p.id = d.party_id
  AND d.place_of_supply_source IS NULL
  AND d.doc_type IN ('sales_invoice', 'purchase_bill', 'credit_note', 'debit_note');

CREATE INDEX IF NOT EXISTS books_documents_pos_idx
  ON books_documents (client_id, doc_type, place_of_supply)
  WHERE status = 'posted' AND deleted_at IS NULL;
