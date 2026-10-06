# Parallel plan - finish Phase 1 + Phase 2 (Cursor stream A, Claude Code stream B)

Written 2026-10-06 at f053303 (C3-1..C3-3 pushed). Specs: docs/plan/arnibooks-cursor-prompts.md (Phase 1 lines
140-187, Phase 2 lines 191-244) and docs/plan/arnibooks-cursor-prompts-addendum-C.md (C3 lines 167-209, C4 213-226).

## Collision rules (both streams)
| Topic | Stream A - Cursor | Stream B - Claude Code |
|---|---|---|
| Folder / branch | main folder, `feat/books-phase1` | worktree `..\aa-claude`, branch `feat/p2-stream-b` |
| New migrations | db/38 - db/49 only | db/50 - db/59 only |
| Owns (may edit) | bank-transactions.ts, settlements.ts, open-items.ts, allocations, matching/scoring, rules, src/app/books/transactions/**, side peek panel | documents.ts (void/notes/emirate), new recon + dashboard modules, src/app/books/page.tsx (dashboard), banking page recon column, goldens v2, docs/plan/*.md |
| Must NOT edit | documents.ts, dashboard, goldens | bank-transactions.ts, settlements.ts, open-items.ts, transactions page |
| Shared files (append-only, small hunks) | package.json "test" list, e2e/global-setup.mjs migration list, src/lib/api-error.ts messages, src/app/api/books/[...path]/route.ts (add routes only) | same |

- Tests: scripts/ai/gates.ps1 and scripts/ai/test-files.ps1 take a shared lock (~/.arnibooks-gates.lock); if the other
  stream is testing, yours waits. Never bypass it (no direct docker runs against daftar_test / daftar_e2e).
- Local commits only, never push. Prefixes: A = "P2A-n:", B = "P2B-n:".
- Stream B rebases on feat/books-phase1 before each hand-back; the owner merges B into feat/books-phase1.
- Owner decisions still open (do not decide them in code): VAT on customer advances; Company A golden values
  (PROVISIONAL). Flag them, never invent.

## Stream A - Cursor (bank side: matching, allocation, rules)
A1  Split matching + differences: one bank line -> several open items (1:N); several bank lines -> one open item
    (N:1, partial payments); difference lines (bank fee / FX difference / discount) to the right accounts; posting
    requires unallocated = 0. Allocation types per line: Against item, **On account**, **Advance** (from Tally
    review 2026-10-06; traceable per receipt, applicable to a later invoice; NO VAT on advances - flag).
A2  Matching engine: score = weighted amount/date/name/reference with breakdown shown in the panel; >= 0.85
    "ready", 0.5-0.85 "suggested", < 0.5 none; direction mismatch never matches; +/-90-day cross-period flag;
    partial-payment subset-sum bundle; rejected suggestions remembered.
A3  Rules engine for bank lines: conditions (counterparty contains / narration regex / amount range / account /
    direction) -> actions (type, account, VAT code, tags, counterparty); priority; test-on-history preview;
    "create rule from this transaction"; suggestion chip "Rule: <name>".
A4  Gateway + card completeness: Stripe/POS payout groups where clearing must net to 0 per payout (else exception);
    card repayment Dr Card Payable / Cr Bank; e2e "Unmatched -> pick invoice -> post -> journal with link back".

## Stream B - Claude Code (document side, reconciliation, dashboard, goldens)
B1  Void = reversal for posted sales invoices / purchase bills (reversal journal, open item closed, audited, dual
    control); confirm credit/debit notes link to originals and reduce the open item.
B2  Place of supply: posted documents record the emirate from the party master (override audited) for VAT 201
    grouping; design note docs/plan/vat201-by-emirate.md (report itself later).
B3  Bank reconciliation check per account + period: bank ledger balance = latest statement closing balance;
    difference shown on Banking page and as an API; unreconciled list.
B4  C4 dashboard "This month" checklist (addendum-C C4): statements coverage, documents to review, bank lines to
    review, unassigned inbox, period status + VAT due; issues badge.
B5  Golden v2 (Phase 2 tests): synthetic month-1 statements for companies A/B/C reconciled -> expected journals +
    TB + bank recon; cases: partial payment, one payment for two invoices, bank fee difference, own-account transfer,
    card repayment, Stripe payout, USD account. Depends on A1-A2 - do last, after rebasing on A's work.
B6  "Add transaction via receipt" (Phase 2 4): upload receipt -> worker extraction -> match to an existing card/bank
    line or create an expense draft. Only if time remains.
