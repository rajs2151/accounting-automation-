-- P2A-4: payout groups for gateway clearing net-zero; card/gateway post paths use COA 2150/1310.

ALTER TABLE books_bank_transactions
  ADD COLUMN IF NOT EXISTS payout_group_key text;

CREATE INDEX IF NOT EXISTS books_bank_txn_payout_group_idx
  ON books_bank_transactions (client_id, payout_group_key)
  WHERE payout_group_key IS NOT NULL;

COMMENT ON COLUMN books_bank_transactions.payout_group_key IS
  'P2A-4: Stripe/POS payout group; clearing must net to 0 across the group';
