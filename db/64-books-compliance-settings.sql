-- Phase 2 screenshot review (items 8, 10, 12): company compliance settings + journal posted_by.
-- Additive + idempotent. No RLS change (clients / books_journal_entries already tenant-scoped).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS vat_registration_status text;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_vat_registration_status_check;
ALTER TABLE clients ADD CONSTRAINT clients_vat_registration_status_check CHECK (
  vat_registration_status IS NULL
  OR vat_registration_status IN ('registered', 'not_registered', 'voluntary')
);

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS designated_zone boolean NOT NULL DEFAULT false;

-- Dual control (preparer ≠ approver) is on by default; false is lab-only.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS require_dual_control boolean NOT NULL DEFAULT true;

-- NULL = not recorded; true/false = recorded election / status.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS sbr_elected boolean;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS is_qfzp boolean;

COMMENT ON COLUMN clients.vat_registration_status IS
  'FTA VAT registration: registered | not_registered | voluntary; NULL = unset';
COMMENT ON COLUMN clients.designated_zone IS
  'True when the establishment is in a designated zone for VAT.';
COMMENT ON COLUMN clients.require_dual_control IS
  'When true (default), post/reverse/lock require preparer ≠ approver.';
COMMENT ON COLUMN clients.sbr_elected IS
  'Small Business Relief election for CT; NULL means unset (do not assume relief).';
COMMENT ON COLUMN clients.is_qfzp IS
  'Qualifying Free Zone Person status; NULL means unset.';

ALTER TABLE books_journal_entries
  ADD COLUMN IF NOT EXISTS posted_by uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS books_journal_entries_posted_by_idx
  ON books_journal_entries (client_id, posted_by)
  WHERE posted_by IS NOT NULL;
