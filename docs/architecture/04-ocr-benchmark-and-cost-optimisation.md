# 04 — OCR benchmark and cost optimisation

**Retrieval date: 2026-10-03.**  
**Harness runs only on synthetic or owner-approved anonymised files. No files leave the machine unless you explicitly approve a cloud candidate run.**

## 1. Summary

Specify a reproducible benchmark harness under `scripts/benchmarks/` comparing local Tesseract, open-source layout/OCR engines, and (only if approved) AWS Textract, one other managed doc AI, and one vision LLM. Metrics cover field/row accuracy, $/page, latency, Arabic, and failures. Default recommendation until benches complete: **local text-layer + Tesseract ladder**; managed/LLM as gated fallbacks. Cost-saving tactics are mandatory in the router.

## 2. Options table (candidates)

| Candidate | Licence / notes | Arabic | Runs where | Status |
|---|---|---|---|---|
| Current Tesseract (worker) | Apache-2.0 engine | `ara` traineddata available; quality **UNVERIFIED** | Local | Baseline |
| PaddleOCR | Apache-2.0 — verify version in spike | Multilingual incl. Arabic claims **UNVERIFIED** until run | Local | Candidate |
| docTR / similar layout | Check BSD/Apache at pin time | **UNVERIFIED** | Local | Candidate |
| AWS Textract | AWS ToS; list price DetectDocumentText **$0.0015/page** first 1M/month (US West Oregon) — [aws.amazon.com/textract/pricing](https://aws.amazon.com/textract/pricing/) | Support matrix **UNVERIFIED** for ara bank PDFs | Cloud — needs approval | Candidate |
| Google Document AI / Azure DI | Vendor ToS; price **UNVERIFIED** until quote | Vendor docs | Cloud — needs approval | Pick one |
| Vision LLM (e.g. via Bedrock/Vertex) | Vendor ToS; $/1k tokens **UNVERIFIED** | Often strong | Cloud — needs approval | Last resort |

## 3. Recommendation (confidence: **medium** until benches run)

**Default method:** digital text extract → vendor template → local OCR (Tesseract eng+ara).  
**Fallback:** managed OCR (Textract Analyze Expense / Tables) only with approval + budget cap.  
**Last:** vision LLM on hard pages only; always human review before post.  
Re-rank after V1 benchmark report (synthetic goldens).

### 3.1 Harness spec

Location: `scripts/benchmarks/` (see companion scripts).

| Item | Spec |
|---|---|
| Dataset | `fixtures/ocr-bench/` synthetic only in repo; external goldens path via env, never committed if sensitive |
| Labels | JSON: fields (date, counterparty, TRN, invoice#, currency, taxable, vat, total) + bank rows |
| Metrics | Field exact-match & normalized F1; bank row F1; cost/page; p50/p95 latency; Arabic CER on samples; failure taxonomy |
| Protocol | Same preprocess; freeze model versions; log raw outputs to `artifacts/` (gitignored) |
| Cloud | Requires `--allow-cloud` and `BENCH_CLOUD=1`; default off |

### 3.2 Break-even (illustrative; recompute with local infra $)

Assumptions marked **UNVERIFIED** where not measured:

| Volume pages/month | Local OCR marginal $/page | Textract DetectDocumentText $/page (list) | Prefer |
|---|---|---|---|
| 1,000 | ≈ infra only (**UNVERIFIED** $0.000–0.001) | $0.0015 | Local |
| 20,000 | Local if GPU/CPU sunk | $30 @ $0.0015 | Local default; managed for fails |
| 200,000 | Local + queue | $300 @ $0.0015; Forms/Tables much higher ($0.015–$0.05) — [pricing](https://aws.amazon.com/textract/pricing/) | Router essential |

**Conclusion:** At Arnifi 50–100 clients, managed OCR on 100% pages is usually wasteful; use on low-confidence subset only.

### 3.3 Cost-saving tactics

| Tactic | Expected saving | Evidence |
|---|---|---|
| Route by difficulty | 50–90% pages never hit paid API | Industry pattern; measure in harness |
| Vendor-template memory | High on repeat suppliers | Tofu-like; measure hit rate |
| Dedupe by sha256 | 100% on duplicates | Free |
| Preprocess (deskew, DPI) | +accuracy, fewer LLM escalations | Bench A/B |
| Batch inference | Lower $/page for self-host GPU | **UNVERIFIED** until timed |
| Cache by hash+method+version | Avoid re-OCR | Free |
| Early exit on validated balances | Skip LLM if TB/statement balances | Domain rule |
| DetectDocumentText not Forms+Tables when LLM parses | ~40× vs $0.065 stack — see AWS sample discussion citing $0.0015 vs $0.065 | [aws-samples commit note](https://github.com/aws-samples/sample-agentic-idp-evaluation-framework/commit/1fe43955cb207634c954348f79ce9984cbbb4e30) + [Textract pricing](https://aws.amazon.com/textract/pricing/) |

## 4. Cost and effort

| Work | Likely pw |
|---|---|
| Harness + synthetic goldens | 2 |
| Local engine matrix | 2 |
| Cloud adapters (gated) | 1 |
| Report notebook/markdown | 1 |

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Accidental cloud send | Default deny; CI grep for allow flags |
| Overfitting to synthetic | Add approved anonymised later |
| Arabic quality gap | Explicit ara metric; escalate path |

## 6. Evidence still needed

- Run harness outputs (raw) after synthetic set exists.
- Region-specific Textract prices for chosen AWS region.
- Second managed vendor quote.
- Owner approval for any cloud run.

## 7. Open questions (≤10)

1. Approve cloud benchmark on synthetic only?
2. Prefer Textract vs Google vs Azure as the one managed candidate?
3. Vision LLM vendor preference?
4. Target field F1 for auto-suggest (not auto-post)?
5. GPU available for local layout models?
6. Who labels synthetic goldens?
7. Include handwritten samples in v1 bench?
8. Max $/page budget hard cap?
9. Bank-statement row metric weighted higher than invoice fields?
10. When may approved anonymised client pages enter the bench?
