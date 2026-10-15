# Golden v2 (Phase 2 Stream B / B5)

Hand-computed bank reconciliation + journal expectations for month-1 cases.
Amounts are integer fils. Do not regenerate from app dumps.

Cases covered by `src/server/books/golden-v2.test.ts`:

| Case | Expected |
|------|----------|
| Partial payment | Open item remaining = invoice − receipt |
| One payment / two invoices | Both open items reduced; bank allocation sums to receipt |
| Bank fee difference | Receipt + fee lines; AR cleared; fee expense posted |
| Own-account transfer | Linked pair; one CV; Dr bank B / Cr bank A |
| Card repayment | Dr 2150 / Cr bank |
| Stripe payout group | Group nets to 0 or `gateway_payout_not_balanced` |
| USD account | Original USD + AED on bank lines |

See also P2A-4 unit coverage for Stripe payout groups.
