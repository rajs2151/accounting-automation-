# Phase 1 + Addendum A — acceptance

Shipped as **engine + tests** (stub forms corrected for money/dates/validation; full screens from Addendum C next). Company A month-1 golden remains **PROVISIONAL** until owner hand-computed values land.

## 1. Classification / OCR / match / dedupe

| Requirement | Test name | Pass |
|---|---|---|
| Classify per doc type (sales/purchase/bank/card/gateway/TB) | `test_classify_per_doc_type` | pass |
| Low-confidence → user picks | `test_low_confidence_classification_needs_user_pick` | pass |
| Text-layer PDF route | `test_text_layer_route_on_pdf` | pass |
| docTR OCR on scanned image fixture | `test_doctr_ocr_route_on_scanned_image` | pass |
| Mixed PDF handled per page | `test_mixed_pdf_handled_per_page` | pass |
| EasyOCR Arabic fallback | `test_easyocr_arabic_fallback` | pass |
| Company match → Unassigned when no TRN/IBAN/name | `test_company_match_unassigned_when_no_match` | pass |
| Duplicate detection (file hash + type/number/party/amount) | `test_duplicate_detection_hash_and_identity` | pass |

Pytest (worker image, `PYTEST_UNIT_ONLY=1`): **9 passed**.

## 2. Fixture counts + extraction-eval

```
=== Fixture counts ===
  text_pdfs: 10
  scans: 5
  bank_layouts: 3
  card: 1
  stripe_csv: 1
  mixed_pdf: 1
  arabic_scan: 1
  meets_minimums: True

=== Field P/R by route (amounts/dates/TRN/invoice_no) ===
  text: P=1.0000 R=1.0000 tp=40 fp=0 fn=0 silent_misses=0 target>=0.99 pass=True
  scan: P=1.0000 R=0.9583 tp=23 fp=0 fn=1 silent_misses=0 target>=0.95 pass=True

=== Field P/R by doc type ===
  bank_statement: (no amount/date/TRN fields — count=3)
  card_statement: (no amount/date/TRN fields — count=1)
  gateway_statement: (no amount/date/TRN fields — count=1)
  sales_invoice: P=1.0000 R=0.9853 n=17 silent_misses=0
```

## 3. Statement drop-row

| Requirement | Test name | Pass |
|---|---|---|
| Drop one fixture row → running-balance check flags | `statement recheck catches dropped row` | pass |

Seeded UI demos: balanced `…098` + dropped-row `…088` (RB ✗ on gap line).

## 4. Accounting

| Requirement | Test name | Pass |
|---|---|---|
| Deferred release schedule (+ blocked when target period locked) | `deferred release schedule + blocked when target period locked` | pass |
| 1220 nets to zero per client after bill + rebill | `1220 nets to zero per client after bill + rebill` | pass |
| CN reverses VAT with same code | `CN reverses VAT with same code` | pass |
| 2320 advance later allocated to an invoice | `2320 advance later allocated to an invoice` | pass |
| INV-SYN-001 line sum (100+5=105) no false mismatch | `INV-SYN-001: 100.00 + VAT 5.00 = 105.00 does not flag line_sum_mismatch` | pass |
| Real mismatch flags line_sum_mismatch | `real mismatch: 100.00 + VAT 5.00 vs grand 120.00 flags line_sum_mismatch` | pass |
| BBox centre on value text | `demo invoice bbox centres fall on the value text` | pass |
| Parsing / FX / party de-dupe / SV / RCM / USD FX / CV / OB locked reject / rebuild OI / CN exceed | existing `phase1.test.ts` | pass |

## 5. Opening import unlock → import → relock (audited)

| Requirement | Test name | Pass |
|---|---|---|
| Unlock (reason) → import → relock; audit unlock/lock + post_opening | `opening import unlock → import → relock path audited` | pass |

UI: Settings → Opening balances (file upload + AED mapping table + AR/AP party detail + unlock/map/post/relock).

## 6. E2E (`docker compose --profile e2e run --rm e2e`)

Phase 1 ship gate (`E2E_PHASE1_GATE=1`): **3 passed, 0 failed**.

```
+ E2E_PHASE1_GATE: running e2e/books-phase1.spec.ts only
  ✓ phase1: sales purchases parties inbox visible
  ✓ phase1 screenshots: review, statement, purchases, receipts, settings OB
  ✓ phase1: upload bill → approve → journal visible
  3 passed
```

Legacy specs under `e2e/legacy/` are **not** in CI gate (`npm run test:e2e:docker`). Full suite (`E2E_PHASE1_GATE=0`): 12 passed / 8 failed (legacy visual/dashboard/grid).

Company A month-1 golden: **PROVISIONAL** (`_provisional: true`) — agent-drafted; harness skips until owner hand-computed values.

## 7. Screenshots

| Screen | File |
|---|---|
| Review (real PDF + aligned boxes, human labels) | `docs/phase1/review-split-view.png` |
| Statement review (balanced) | `docs/phase1/statement-review.png` |
| Statement review (dropped-row ✗) | `docs/phase1/statement-review-dropped.png` |
| Purchases (AED + dd/mm) | `docs/phase1/purchases.png` |
| Receipts (no “as Layla”) | `docs/phase1/receipts.png` |
| Settings OB mapping | `docs/phase1/settings-ob.png` |
| Settings profile + periods | `docs/phase1/settings-profile-periods.png` |

## 8. docTR in worker image

```json
{
  "doctr_installed": true,
  "easyocr_installed": true,
  "doctr_det_arch": "db_resnet50",
  "doctr_reco_arch": "crnn_vgg16_bn",
  "easyocr_langs": "en,ar",
  "models_loaded": [
    "doctr:db_resnet50+crnn_vgg16_bn",
    "easyocr:en,ar"
  ]
}
```
