-- P2B-5: place of supply by supply type (owner decision 2026-10-06, pending tax-adviser confirmation):
--   services → supplier's establishment emirate (sales: the company's own emirate), goods → delivery
--   emirate (sales: the party's). The rule itself lives in one function (place-of-supply.ts).
-- Additive + idempotent.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS establishment_emirate text;
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_establishment_emirate_check;
ALTER TABLE clients ADD CONSTRAINT clients_establishment_emirate_check CHECK (
  establishment_emirate IS NULL OR establishment_emirate IN (
    'Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'
  )
);

-- What the document supplies (derived from its lines): drives which emirate rule applies.
ALTER TABLE books_documents ADD COLUMN IF NOT EXISTS supply_type text;
ALTER TABLE books_documents DROP CONSTRAINT IF EXISTS books_documents_supply_type_check;
ALTER TABLE books_documents ADD CONSTRAINT books_documents_supply_type_check CHECK (
  supply_type IS NULL OR supply_type IN ('goods', 'services', 'mixed', 'none')
);

-- New sources: 'company' (company establishment emirate) and 'not_applicable' (no VAT-able lines,
-- e.g. disbursement-only rebills — never a VAT 201 gap).
ALTER TABLE books_documents DROP CONSTRAINT IF EXISTS books_documents_pos_source_check;
ALTER TABLE books_documents ADD CONSTRAINT books_documents_pos_source_check CHECK (
  place_of_supply_source IS NULL
  OR (place_of_supply_source IN ('party', 'company', 'original') AND place_of_supply IS NOT NULL)
  OR (place_of_supply_source = 'override' AND place_of_supply IS NOT NULL
      AND COALESCE(btrim(place_of_supply_reason), '') <> '')
  OR (place_of_supply_source IN ('missing', 'not_applicable') AND place_of_supply IS NULL)
);
-- Existing rows keep their db/51 snapshot until an admin runs reapplyPlaceOfSupplyRule.
