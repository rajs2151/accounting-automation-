# Phase 3 — Coverage audit (report only)

**Date:** 2026-10-09  
**Branch:** `feat/books-phase1`  
**Rule:** Do not implement from this doc until owner approves a ranked slice.

COA source: `db/20-books-coa-v2.sql` (template + Desert Falcon / Gulf Crest / Palm Grove copies).

---

## A. Chart of accounts (grouped)

### Assets
| Codes | Group | statement_line |
|-------|--------|----------------|
| 1110–1130 | Cash & bank / card clearing | BS_current_assets |
| 1210–1240 | Trade AR, disbursements, employee advances, owner CA (Dr) | BS_current_assets |
| 1310–1390 | Gateway / POS / transfer clearing, suspense | BS_current_assets |
| 1410–1440 | Prepayments, deposits, VAT input / receivable | BS_current_assets |
| 1510–1520 | Inventory | BS_current_assets |
| 1610–1690 | Fixed assets + accum. depreciation | BS_nca |
| 1710–1790 | Intangibles + accum. amortisation | BS_nca |

### Liabilities
| Codes | Group | statement_line |
|-------|--------|----------------|
| 2110–2150 | Trade AP, accruals, reimbursable, gov fees, card payable | BS_current_liab |
| 2210–2230 | VAT output / settlement, CT payable | BS_current_liab |
| 2310–2340 | Deferred revenue, customer advances, salaries payable, owner CA (Cr) | BS_current_liab |
| 2410–2420 | EOSB provision, long-term loans | BS_ncl |

### Equity
| Codes | Notes |
|-------|--------|
| 3100 Share capital | Postable |
| 3200 Retained earnings | Year-end close target |
| 3300 Current year earnings | COA present; BS often uses synthetic CYE |
| 3400 Owner drawings | Contra equity |
| 3900 Opening balance equity | Opening import balancer |

### P&L
| Codes | statement_line |
|-------|----------------|
| 4100–4900 | PL_revenue |
| 5100–5300 | PL_cogs |
| 6100–6910 | PL_opex (+ PL_depr for 6800/6810) |
| 7100–7500 | PL_other |
| 8100 | PL_tax |

---

## B. Coverage matrix

| # | Area | Status | What’s there | What’s missing |
|---|------|--------|--------------|----------------|
| 1 | Accruals + auto-reversal | **Partial** | Expense accrual template → 2120 + `auto_reverse_next_period` (`journal-templates`, worker `auto_reverse`) | Income accrual template / workflow |
| 2 | Prepayments + amortisation | **Partial** | 1410 + prepayment template (asset warning) | Monthly release schedule / job |
| 3 | Deposits / staff advances / owner CA | **Partial** | 1220, 1420, 2130, 1240/2340 (manual/JV) | 1230 staff-advance flow; registers |
| 4 | Investments | **Missing** | — | No COA / posting / UI |
| 5 | Inventory | **Partial** | 1510/1520 + purchase `inventory` line | Qty / valuation / COGS (low value for service SME) |
| 6 | Loans + interest | **Partial** | 2420, 7400 (manual) | Loan register + interest accrual |
| 7 | Payroll / WPS + EOSB | **Partial** | 6100–6120, 2330, 2410; payroll template (Cr 2120 today) | WPS import; EOSB schedule; Cr 2330 |
| 8 | Unearned / advances | **Partial** | 2310 deferred schedules; **2320** + `books_party_advances` | Advances/deferred dashboard UI |
| 9 | Credit notes / bad debt / ECL | **Partial** | Credit notes + 4900 | Bad-debt write-off / ECL |
| 10 | VAT (RC, import, advance, ZR/EX, VAT201) | **Partial** | Codes + draft `generateVat201Draft` + close gate + RC on bills | Books VAT201 **page**; import boxes 6–7; advance VAT |
| 11 | CT / deferred tax / dividends / YE | **Partial** | CT estimate banner; YE → 3200; 8100/2230 accounts | CT accrual post; deferred tax; dividend voucher |
| 12 | Intangibles / IFRS 16 | **Partial** / **Missing** | IA via fixed-assets register (1710/1790/6810) | IFRS 16 ROU / lease liability |
| 13 | FX revaluation + multi-currency | **Partial** (core Exists) | Preview + draft JV + close gate + Close UI button | Auto rates; full monetary BS scope |
| 14 | Opening import / intercompany | **Partial** / **Missing** | Opening import in Settings (3900) | Intercompany (1340 ≠ IC) |
| 15 | BS / CF mapping | **Partial** | Every leaf has `statement_line` + `cash_flow_class`; engine fallbacks | 3300 vs synthetic CYE clarity; no “unmapped TB” report |

---

## C. Minimal designs — ranked for UAE **service** SME

Approve a rank before any build.

| Rank | Slice | Minimal design | Close / report |
|------|--------|----------------|----------------|
| 1 | Prepayment amortisation | `books_prepaid_schedules` + job `prepaid_release` (Dr opex / Cr 1410) | Gate: pending release in period |
| 2 | Income accrual template | Dr 1210 / Cr 4100 + auto-reverse (same pattern as expense accrual) | Reuses scheduled-draft checks |
| 3 | Books VAT 201 page | `/books/reports/vat201` on existing draft API; no auto-post | Existing VAT control gate |
| 4 | CT accrual draft | Optional Dr 8100 / Cr 2230 from estimate | Gate estimate vs 2230 |
| 5 | Payroll payable template | Cr **2330**; optional WPS CSV later | Unpaid salaries info gate |
| 6 | Advances / deferred panel | Read-only 2320 + deferred schedules | Optional 2320 vs subledger drift |
| 7 | Bad debt write-off v1 | Dr expense/4900 / Cr 1210; link open item | Optional AR review |
| 8 | EOSB monthly accrual | Manual/table → Dr 6110 / Cr 2410 | Warn if 2410 stale |
| 9 | Loan interest | `books_loans` + monthly Dr 7400 / Cr 2420 | Interest not posted |
| 10 | Staff advances 1230 | Payment + recovery on expenses | Info if 1230 ≠ 0 |
| 11–16 | Import VAT, investments, IFRS 16, deferred tax, IC, inventory depth | Defer for service SME | — |

**Highest ROI next:** (1) prepaid release → (2) income accrual → (3) VAT201 page → (4) CT accrual draft → (5) payroll Cr 2330.

---

## D. Owner decisions still open (do not build)

### D1 — VAT on customer advances (item 5)
**Today:** unmatched receipt remainder → **Cr 2320 gross**; memo “VAT on advances TBD”; no 2210.

**Propose (await OK):**
1. If customer is UAE taxable (TRN + mainland/FZ taxable supply): split advance as **net → 2320**, **VAT → 2210** (gross × 5/105, integer fils).
2. Store VAT portion on `books_party_advances` (or linked audit row).
3. On apply to invoice: Dr 2320 net + Dr 2210 VAT (or reverse VAT into invoice VAT) so output is not double-counted.
4. Close / VAT201: include advance VAT in Box output for the period received (FTA cash/accrual policy — confirm accrual recognition on receipt).

### D2 — Sequential period lock (item 4)
**Today:** any OPEN month can be locked independently.

**Propose (await OK):** Within a fiscal year, lock month N only if month N−1 is LOCKED (or N is books-start month). Unlocking N marks N+1 close “not ready” until N is re-locked. Do **not** auto-lock prior months.

**Jul–Sep 2026 status (Desert Falcon seed):** only months generated from books start exist in seed (typically May–Jun OPEN in demo); Jul–Sep are **absent** until periods are generated — not silently open.

### D3 — VAT 201 posting generator (Phase 4 / prior item 9)
**Today:** `generateVat201Draft` + close gate vs 2210/1430; seed warn on manual pure VAT settlement; no dedicated post-from-return.

**Propose (await OK):**
1. UI: `/books/reports/vat201` — draft boxes, period, due date (blocked until emirate + return period set — already enforced).
2. Action **Prepare settlement JV** (draft only): Dr 2210 / Cr 1430 (net) → Cr/Dr **2220** for payable/refund; dual-control post.
3. Idempotent per tax period; never auto-post; audit `vat201_settlement`.
4. Import boxes 6–7 and advance VAT = later slices after D1/D3 OK.

---

*End of Phase 3 report. No implementation from this file until you pick ranks / approve D1–D3.*
