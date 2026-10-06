-- P2B-4: VAT return stagger per company (dashboard "VAT due"). Additive + idempotent.
-- NULL = not set yet (dashboard says so; never guessed). The FTA assigns each registrant a tax period
-- (monthly or quarterly) and a stagger; we store the month in which one tax period ends.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS vat_return_frequency text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS vat_period_end_month int;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_vat_stagger_check;
ALTER TABLE clients ADD CONSTRAINT clients_vat_stagger_check CHECK (
  (vat_return_frequency IS NULL AND vat_period_end_month IS NULL)
  OR (vat_return_frequency = 'monthly' AND vat_period_end_month IS NULL)
  OR (vat_return_frequency = 'quarterly' AND vat_period_end_month BETWEEN 1 AND 12)
);
