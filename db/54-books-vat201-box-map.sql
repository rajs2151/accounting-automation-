-- P2B-6: VAT 201 box mapping by direction (owner decision 2026-10-06). Additive + idempotent.
-- db/23 had one column (vat201_box) with ZR → '6' and EX → '8', which are not the current form's boxes.
--   output (sales):     SR → 1 (1a–1g by place-of-supply emirate) · RC_OUT → 3 · ZR → 4 · EX → 5
--   input (purchases):  SR → 9 · RC_IN → 10
-- OS, NR (blocked input) and the other direction of each code report nowhere.

ALTER TABLE books_vat_codes ADD COLUMN IF NOT EXISTS vat201_output_box text;
ALTER TABLE books_vat_codes ADD COLUMN IF NOT EXISTS vat201_input_box text;

UPDATE books_vat_codes v SET vat201_output_box = m.out_box, vat201_input_box = m.in_box
FROM (VALUES
  ('SR', '1', '9'),
  ('ZR', '4', NULL),
  ('EX', '5', NULL),
  ('OS', NULL, NULL),
  ('RC_OUT', '3', NULL),
  ('RC_IN', NULL, '10'),
  ('NR', NULL, NULL)
) AS m(code, out_box, in_box)
WHERE v.code = m.code;

-- Keep the legacy single column consistent for anything still reading it.
UPDATE books_vat_codes SET vat201_box = '4' WHERE code = 'ZR';
UPDATE books_vat_codes SET vat201_box = '5' WHERE code = 'EX';
COMMENT ON COLUMN books_vat_codes.vat201_box IS
  'Deprecated (P2B-6): use vat201_output_box / vat201_input_box.';

ALTER TABLE books_vat_codes DROP CONSTRAINT IF EXISTS books_vat_codes_vat201_boxes_check;
ALTER TABLE books_vat_codes ADD CONSTRAINT books_vat_codes_vat201_boxes_check CHECK (
  (vat201_output_box IS NULL OR vat201_output_box IN ('1', '2', '3', '4', '5', '6', '7'))
  AND (vat201_input_box IS NULL OR vat201_input_box IN ('9', '10'))
);
