# 07 — Cost model

**Retrieval date: 2026-10-03.**  
Parametric model; **accountant hourly cost not known yet** — left as input `H`. Spreadsheet: [arnibooks-cost-model.csv](./arnibooks-cost-model.csv).

## 1. Summary

Estimate infra + AI + human review cost per client/month and per VAT return across 10 / 50 / 100 / 500 clients. Largest drivers at Arnifi scale are **accountant review time** and **paid OCR/LLM share**, not Postgres. Metering, quotas, and an AI spend kill switch are mandatory before cloud OCR is enabled.

## 2. Options table

| Cost posture | Options | Trade-offs | Flip evidence |
|---|---|---|---|
| OCR | 100% local · Hybrid router · 100% managed | Hybrid recommended (doc 04) | Bench $/page |
| LLM | Off · Escalation only · Wide use | Escalation only | Privacy + $ |
| Human review | Full review · Exception-only | Exception-only after trust | Error rate |

## 3. Recommendation (confidence: **medium** — inputs incomplete)

Run **hybrid OCR** + **exception review**. Price internal transfer using measured review minutes × `H`. Cap cloud AI with monthly budget + kill switch.

### 3.1 Parameters (defaults — replace when known)

| Parameter | Default | Source |
|---|---|---|
| Clients `C` | 10/50/100/500 | Scenarios |
| Docs/client/month `D` | 40 | **UNVERIFIED** assumption |
| Mix structured/text/scan/photo | 10% / 50% / 30% / 10% | **UNVERIFIED** |
| Pages/doc `P` | 2.5 | **UNVERIFIED** |
| Paid OCR share of pages | 15% | Router target |
| LLM share of pages | 3% | Hard-tail |
| Textract DetectDocumentText | $0.0015 / page (first 1M, US West Oregon list) | [AWS Textract pricing](https://aws.amazon.com/textract/pricing/) |
| LLM $/page equivalent | $0.02 | **UNVERIFIED** placeholder |
| Storage $/GB-month | $0.023 | **UNVERIFIED** S3 standard-ish; confirm region |
| Postgres + compute / month | $150 @10 → $2,000 @500 | **UNVERIFIED** order-of-magnitude |
| Review minutes / doc | 3 | **UNVERIFIED** |
| Hourly cost `H` | **INPUT** | Owner pending |
| VAT returns / client / year | 4 | Quarterly assumption |

### 3.2 Scenario outputs (formulas)

Let `pages = C * D * P`.  
`ocr$ = pages * paid_ocr_share * 0.0015`  
`llm$ = pages * llm_share * 0.02`  
`human$ = C * D * (review_min/60) * H`  
`infra$` from table.  
`per_client_month = (infra$ + ocr$ + llm$ + human$ + storage$) / C`  
`per_vat = per_client_month * 12 / 4`

Illustrative if `H = 50` USD/hour (**not provided — example only**):

| Clients | Infra+AI $/mo (approx) | Human $/mo | $/client-mo | $/VAT return |
|---|---|---|---|---|
| 10 | ~200 | 1,000 | ~120 | ~360 |
| 50 | ~450 | 5,000 | ~109 | ~327 |
| 100 | ~800 | 10,000 | ~108 | ~324 |
| 500 | ~3,500 | 50,000 | ~107 | ~321 |

**Sensitivity:** Human line dominates; ±1 minute review/doc moves cost more than Textract list price. If `H` unknown, report infra+AI separately (CSV columns).

### 3.3 Metering and kill switch

| Control | Spec |
|---|---|
| Meter | pages_processed by method, tokens, storage GB, review minutes |
| Quotas | Per-tenant monthly page + LLM caps |
| Alerts | 50% / 80% / 100% budget |
| Kill switch | Feature flag disables cloud OCR/LLM globally and per tenant |
| Pricing implication | Internal chargeback = measured AI + allocated infra + review |

## 4. Cost and effort

Building metering: ~3 pw. Finance calibration workshop: 0.5 pw.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Underestimated review time | Time-study on 10 clients |
| Cloud bill runaway | Kill switch + hard quota |
| Using US prices in UAE region | Re-quote Textract in chosen region |

## 6. Evidence still needed

- Real `H`, `D`, mix, pages/doc.
- AWS region price list.
- LLM vendor price card.
- Support headcount allocation.

## 7. Open questions (≤10)

1. Provide `H` and doc mix?
2. Target gross margin per client?
3. Pass through AI cost to clients?
4. Include vendor replacement savings in ROI?
5. Currency for model (AED vs USD)?
6. Staging env cost in scope?
7. Pen-test / SOC costs amortized?
8. WhatsApp channel fees later?
9. Free tier assumptions allowed?
10. Who owns the monthly cost review?
