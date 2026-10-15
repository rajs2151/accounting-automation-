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
| 3 | Deposits / staff advances / owner CA | **Partial** | 1220, 1420, 2130, 1240/2340; **1230 staff advance templates** + info gate | Owner CA register |
| 4 | Investments | **Missing** | — | No COA / posting / UI |
| 5 | Inventory | **Partial** | 1510/1520 + purchase `inventory` line | Qty / valuation / COGS (low value for service SME) |
| 6 | Loans + interest | **Partial** | 2420, 7400; **`books_loans`** + run interest + close gate | Amortising schedules / repayments UI |
| 7 | Payroll / WPS + EOSB | **Partial** | 6100–6120, 2330, 2410; payroll Cr 2330; **EOSB accrual** template + stale-2410 info gate | WPS import; full EOSB schedule |
| 8 | Unearned / advances | **Partial** | 2310 deferred schedules; **2320** + `books_party_advances`; **/books/advances** panel | Apply/release UX polish |
| 9 | Credit notes / bad debt / ECL | **Partial** | Credit notes + 4900; **bad-debt write-off** (Dr 4900 / Cr 1210 + open item) | ECL provision |
| 10 | VAT (RC, import, advance, ZR/EX, VAT201) | **Partial** | Codes + VAT201 draft + **D1** advance VAT + **D3** settlement prepare | Import boxes 6–7; FTA file |
| 11 | CT / deferred tax / dividends / YE | **Partial** | CT estimate banner; YE → 3200; 8100/2230; **CT accrual draft + close gate** | Deferred tax; dividend voucher |
| 12 | Intangibles / IFRS 16 | **Partial** / **Missing** | IA via fixed-assets register (1710/1790/6810) | IFRS 16 ROU / lease liability |
| 13 | FX revaluation + multi-currency | **Partial** (core Exists) | Preview + draft JV + close gate + Close UI button | Auto rates; full monetary BS scope |
| 14 | Opening import / intercompany | **Partial** / **Missing** | Opening import in Settings (3900) | Intercompany (1340 ≠ IC) |
| 15 | BS / CF mapping | **Partial** | Every leaf has `statement_line` + `cash_flow_class`; engine fallbacks | 3300 vs synthetic CYE clarity; no “unmapped TB” report |

---

## C. Minimal designs — ranked for UAE **service** SME

Approve a rank before any build.

| Rank | Slice | Minimal design | Close / report |
|------|--------|----------------|----------------|
| 1 | Prepayment amortisation | **Built** — `books_prepaid_schedules` + job `prepaid_release` (Dr opex / Cr 1410) | Gate: `prepaid_release` on close |
| 2 | Income accrual template | **Built** — Create Entry template `income_accrual` (Dr 1210 / Cr 4100 + auto-reverse) | Reuses scheduled-draft checks |
| 3 | Books VAT 201 page | **Built** — `/books/reports/vat201` on `GET /api/books/vat201/draft`; no auto-post | Close gate href → VAT 201 |
| 4 | CT accrual draft | **Built** — Create Entry `ct_accrual` + `GET /api/books/ct-accrual` (Dr 8100 / Cr 2230 top-up) | Gate `ct_accrual`: estimate vs 2230 (blocking at FY end) |
| 5 | Payroll payable template | **Built** — Create Entry payroll Cr **2330** (was 2120); optional WPS CSV later | Info gate `salaries_payable` |
| 6 | Advances / deferred panel | **Built** — `/books/advances` read-only 2320 + deferred; `GET /api/books/advances-panel` | Info gate `advances_drift` |
| 7 | Bad debt write-off v1 | **Built** — prepare/post API + ageing AR panel; template `bad_debt` | Dual-control; links open item |
| 8 | EOSB monthly accrual | **Built** — Create Entry `eosb_accrual` (Dr 6110 / Cr 2410) | Info gate `eosb_provision` |
| 9 | Loan interest | **Built** — `db/67-books-loans.sql`, `/books/loans`, run interest drafts | Gate `loan_interest` |
| 10 | Staff advances 1230 | **Built** — templates `staff_advance` / `staff_advance_recovery` | Info gate `staff_advances` |
| 11–16 | Import VAT, investments, IFRS 16, deferred tax, IC, inventory depth | Defer for service SME | — |

**Highest ROI next:** (1) prepaid release → (2) income accrual → (3) VAT201 page → (4) CT accrual draft → (5) payroll Cr 2330.

---

## D. Owner decisions

### D1 — VAT on customer advances (item 5) — **BUILT** (approved 2026-10-09)
1. UAE taxable customer (TRN + UAE, not designated zone): gross advance → **net Cr 2320** + **VAT Cr 2210** (`floor(gross×5/105)`).
2. `books_party_advances.vat_*` columns (`db/68`) store VAT remaining; net balances match 2320.
3. Apply advance: **Dr 2320 net + Dr 2210 VAT / Cr 1210 gross** (no double-count).
4. VAT201 already reads 2210 movement — advance VAT lands in Box output for the receipt period.

### D2 — Sequential period lock (item 4) — **BUILT** (approved 2026-10-09)
Within a fiscal year, lock month N only if prior FY month is LOCKED (or N is books-start / first FY month). Close gate `prior_period_locked`; unlock of N makes N+1 checklist fail that gate until N is re-locked. Does **not** auto-lock priors.

### D3 — VAT 201 posting generator — **BUILT** (approved 2026-10-09)
1. UI: `/books/reports/vat201` — draft boxes, due date, **Prepare settlement JV**.
2. `prepareVat201Settlement` → draft only: Dr 2210 / Cr 1430 → Cr/Dr **2220**; dual-control post separately.
3. Idempotent per tax window via `books_vat201_settlements` (`db/69`); audit action `vat201_settlement`.
4. Import boxes 6–7 remain later slices.

---

*End of Phase 3 report. No implementation from this file until you pick ranks / approve D1–D3.*
