-- D1: store VAT portion of customer advances separately from net (2320).
-- Additive + idempotent.

ALTER TABLE books_party_advances
  ADD COLUMN IF NOT EXISTS vat_original_minor bigint NOT NULL DEFAULT 0
    CHECK (vat_original_minor >= 0);

ALTER TABLE books_party_advances
  ADD COLUMN IF NOT EXISTS vat_aed_minor bigint NOT NULL DEFAULT 0
    CHECK (vat_aed_minor >= 0);

COMMENT ON COLUMN books_party_advances.balance_original_minor IS
  'Net customer advance remaining (matches GL 2320). Gross available = this + vat_original_minor.';
COMMENT ON COLUMN books_party_advances.vat_original_minor IS
  'VAT portion of customer advance remaining (booked to 2210 on receipt; reversed on apply).';
COMMENT ON COLUMN books_party_advances.vat_aed_minor IS
  'AED fils of VAT portion remaining on the advance.';
