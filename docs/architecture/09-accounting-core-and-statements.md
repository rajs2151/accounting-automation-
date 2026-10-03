# 09 — Accounting core and statements spec

**Retrieval date: 2026-10-03.**  
Target layout: **IFRS for SMEs**; label outputs **management accounts** until accounting lead sign-off. VAT rule governance is summarized here and enforced per doc 08.

## 1. Summary

Define reporting framework choices under UAE Companies Law and Corporate Tax rules, statement layouts for TB/P&L/BS/CF, close checklist spanning D1/D2, and how VAT201 packs relate to the ledger. Out of v1: inventory costing, payroll/WPS, consolidation, deferred tax. Person-week cuts called out.

## 2. Options table — reporting framework

| Framework | When appropriate (cited) | Pros | Cons | v1 posture |
|---|---|---|---|---|
| Full IFRS | CT default — [MoF MD 114/2023](https://mof.gov.ae/wp-content/uploads/2023/05/Ministerial-Decision-No.-114-of-2023-on-the-Accounting-Standards-and-Methods-for-Corporate-Tax-Purposes.pdf) Art. 4(1); Companies Law requires international standards — [Decree-Law 32/2021 Art. 27](https://www.moet.gov.ae/documents/20121/376326/Commercial+Companies.pdf/12d14f53-1a3e-47b4-8e70-fac3f672c403) | Complete | Heavier disclosures | Later if revenue > AED 50m |
| IFRS for SMEs | CT election if revenue ≤ AED 50m — MD 114/2023 Art. 4(2); FTA guide 2023-11-06 — [tax.gov.ae](https://tax.gov.ae/Datafolder/Files/Guides/CT/Accounting%20Standards%20Guide%20-%2006%2011%202023.pdf) | Fits most SME clients | Not for all entities | **Target layout** |
| Management accounts | Internal steering | Fast | Not CT-safe alone | **Label until lead sign-off** |

## 3. Recommendation (confidence: **high** on dual-label approach)

Generate statement packages with IFRS-for-SMEs-oriented line sets, watermark/label `Management accounts — pending framework sign-off` until the accounting lead clears. CT computation (Stage E) must state which standard was applied.

### 3.1 Statement layouts (minimum)

| Statement | Lines / notes |
|---|---|
| Trial balance | Account code, name, debit, credit, net; period + comparative optional |
| P&L | Revenue, COGS (if used), gross profit, opex categories, operating profit, finance, PBT, tax expense stub, PAT |
| Balance sheet | Non-current assets (incl. FA NBV), current assets, equity, non-current liab, current liab; prove A=L+E |
| Cash flow | Indirect method v1 (cut candidate: direct method) |
| VAT201 pack | Boxes from ledger VAT controls + transaction annex; QA sheet; not FTA submit |
| Notes | Minimal v1; expand post-sign-off |

### 3.2 Close checklist (D1 → D2)

**D1 — Accruals, depreciation, close, TB**

1. Bank/AR/AP/VAT-control recon exceptions cleared or waived with reason  
2. Accruals/prepayments approved and posted  
3. Depreciation run approved and posted  
4. TB identity holds  
5. Period status → `CLOSED` (or reopen path used with audit)

**D2 — Statements, year-end, RE**

6. P&L / BS / CF generated from closed (or reopen-approved) books  
7. Integrity gates green (doc 08)  
8. Dual-control release of statements pack  
9. At year-end: close P&L to RE; RE roll-forward identity  
10. Opening balances for next year verified  

### 3.3 VAT rule governance (product spec pointer)

- Versioned, effective-dated rules with **FTA source citation** on each rule  
- Golden tests against filed returns/exports you supply  
- Pack release blocked if goldens or identities fail  
- Full mechanics in doc 08 §3.4  

### 3.4 Cut candidates inside D1/D2

| Keep | Cut if needed |
|---|---|
| TB, P&L, BS | Cash flow direct method |
| Straight-line FA | Declining balance |
| Accrual schedules | Complex revenue recognition |
| YE to RE | Deferred tax (out of v1) |
| VAT201 pack | Multi-emirate disclosure polish |

### 3.5 Person-week sizing (statements track)

| Slice | Best / likely / worst |
|---|---|
| TB + gate wiring | 1 / 2 / 3 |
| P&L + BS layouts | 2 / 4 / 6 |
| CF indirect | 1 / 2 / 4 |
| YE + RE | 2 / 3 / 5 |
| VAT pack formatting | 2 / 4 / 6 |

## 4. Cost and effort

Accounting SME review cycles: plan 0.25 FTE across D1/D2. Eng likely **~15 pw** for statements track inside Stage D totals (doc 01).

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Marketing “IFRS compliant” too early | Management-accounts label |
| CT uses wrong framework | Stage E explicit standard flag |
| Statement ≠ ledger | Gates + hash |

## 6. Evidence still needed

- Accounting lead written sign-off criteria.  
- Sample management vs audit pack expectations from Arnifi.  
- Whether free-zone clients need extra note lines in v1.

## 7. Open questions (≤10)

1. Who is accounting lead for sign-off?
2. Comparative prior-period columns in v1?
3. Multi-currency presentation currency always AED?
4. Segment reporting ever in scope?
5. Auditor-friendly export format (XBRL?) out of v1?
6. Include owner drawings presentation standard?
7. Related-party note minimum?
8. Cash flow required before first external client share?
9. VAT annex line-level detail always vs summary?
10. Approve cut list above?
