# Document ingestion: review of current state and decisions (Oct 2026)

Scope: upload → classify → parse/OCR → field extraction → review → post → reports/dashboard,
plus the UI direction for intake/review. Evidence is file:line on `feat/books-phase1` @ 6c6274a.
Timings measured on 4 vCPU (CPU only).

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Keep docTR (+ EasyOCR for Arabic) as the default OCR.** Do not move to AWS Textract now. | Textract has no Arabic support and (per AWS region lists at time of writing) no endpoint in me-central-1 (UAE), so UAE client documents would leave the country. docTR is already built in, costs nothing per page and runs where our data is. The blocker today is wiring, not the OCR model (see §2). |
| D2 | **Add Textract later as an optional provider behind `OCR_PROVIDER`**, only for English-only scans whose docTR confidence stays low, and only if a measured accuracy test on real bills shows a gap. | Cost is small (~$1.50 per 1,000 pages for plain text; AnalyzeExpense costs more, so check the AWS pricing page before deciding), but data residency needs owner/legal sign-off. `OCR_PROVIDER=textract` is a stub today (`worker/src/daftar/extract.py:285-289`). |
| D3 | **"AI layer" = field mapping, not OCR.** When the rule-based invoice parser scores low, send the OCR'd text (not the image) to an LLM to fill vendor, numbers, dates, TRN, lines; the result still lands in *Needs review*, never auto-posts. | Keeps review + dual control intact; the LLM never sees credentials or posts anything. Region/provider choice is an owner decision (same residency question as D2). |
| D4 | **Format routing:** Excel/CSV are parsed directly (no OCR). PDF: text layer when present, OCR only for pages without one. PNG/JPG/JPEG/HEIC: always OCR. | This matches the target flow; today XLSX and images are not handled in the books pipeline (§2). |
| D5 | **UI: follow AI Accountant's pattern for intake and review** (upload modal, Uploads tab with live status, full-page split review with *Approve & next* in the header). **Keep CrossVal's pattern for ledger, journals, TB and reports** (dense tables, tabs with counts, side drawers). | Our review page already has a split view and a better viewer (field highlights, thumbnails); what's missing is the upload modal, live status, header actions and a wider form. Ledger/report screens are already built on CrossVal and work well. Per `.cursor/rules/arnibooks.mdc`: layout only — our own names, colours and wording. |

## 2. Ingestion: what works and what doesn't

**Works:** multi-file upload in one request (`src/app/api/books/[...path]/route.ts:789-845`); duplicate detection by SHA-256 per company
(`src/server/books/inbox.ts:236-268`) and by business key (type, number, party, amount); file sniffing by magic bytes (`worker/src/daftar/sniff.py`);
rule-based classification with a confidence score — below 0.55 goes to *Needs review* (`worker/src/daftar/extraction/classify.py`, `extraction/__init__.py:404-416`);
digital PDFs extract in 0.06–0.09 s; CSV bank/card/Stripe files parse directly; job claiming uses `FOR UPDATE SKIP LOCKED`, so more workers are safe.

**Broken / missing (ranked):**

1. **PNG/JPG bills are never OCR'd.** `parsers/invoice_generic.py:101-103` decodes image bytes as UTF-8 text; `extract_file` is only called for PDFs (`extraction/__init__.py:280`).
2. **OCR text of scanned PDFs is thrown away.** Field extraction runs on the text layer only (`invoice_generic.py:106`), and the OCR fallback reads `extraction.raw_pages`, which does not exist (`extraction/__init__.py:289`). A scanned bill yields ~1 field vs 14 for the same bill digitally.
3. **XLSX is not parsed in books** (CSV-only parsers), although Banking accepts `.xlsx`. A Stripe XLSX crashes with `UnicodeDecodeError`. The legacy statement path (`extract.py:82-145`) already reads XLSX/XLS — reuse it.
4. **Card-statement PDFs crash** (`card_generic` decodes PDF bytes as text; parse call unguarded, `extraction/__init__.py:183`).
5. **Failed jobs leave the item at "Queued" forever** — the worker never sets `extracting` or `failed` on inbox items (`worker/src/daftar/books_jobs.py:94-102`). No retries, no timeout, no recovery of jobs stuck in `running`, no page cap.
6. **No size/type limits on books uploads** (25 MB exists only on the legacy route, `src/app/api/[...path]/route.ts:467-476`). UI `accept` lists differ per page.
7. **Purchase vs sale defaults to sale** when the company's own TRN/name isn't found; `intendedType=purchase_bill` from the Purchases page is stored but not passed to the worker.
8. Digital pages without a date+amount pattern get OCR'd needlessly (two different "has text layer" rules: `extract.py:417-426` vs `pdf_words.py:11-18`).
9. Models load on the first scan, not at worker start (+3–5 s on the first document); the EasyOCR fallback re-OCRs the whole page.
10. Only the Statements page polls status; Inbox/Purchases/Sales don't refresh while extracting.

### Timing (one worker, serial)

| Per document | Time |
|---|---|
| Digital PDF, 1 page | 0.06–0.09 s |
| CSV | ~1 ms |
| Scanned page (render + deskew + docTR) | ~3–10 s depending on word count |
| Arabic / low-confidence page (EasyOCR fallback) | +5–15 s (estimate) |
| First scan after worker start (model load) | +3–5 s once |

| Batch | Digital | 1-page scans | Arabic / poor scans |
|---|---|---|---|
| 10 bills | 1–2 s | ~1 min | ~2 min |
| 50 bills | 5–10 s | 4–8 min | 10+ min |

Scaling: torch already uses all cores, so a second worker on the same 4 vCPU gains little; add workers on separate machines (SKIP LOCKED
makes that safe), or a GPU worker for OCR. The UI must therefore show per-file status — users will see minutes, not seconds, for scanned batches.

## 3. Do extracted values reach the right place?

Reports (TB, P&L, BS, CF, Health) read **posted journals only** — correct design, and the DESERT figures tie (BS balances, CF closing = bank GL).
The problems are in what gets posted and in the receivables/payables open items that feed the dashboard and ageing:

1. **Foreign-currency bank lines post at rate 1.0.** `postBooksBankTransaction` never passes `fxRateScaled` (`src/server/books/bank-transactions.ts:1547,1582`; default 1.0 in `settlements.ts:137`); category/card/gateway posts use the statement amount as AED. Effect: USD amounts booked as AED, false FX loss on 7300, wrong cash on BS/CF/Health/dashboard; bank recon still says "reconciled" because it compares original amounts.
2. **Reverse-charge bills overstate payables by the VAT.** AP is credited net (`documents.ts:709`), the open item is gross (`documents.ts:952-962`). Ageing/AP tile too high; a full payment leaves the VAT open.
3. **Bank lines and manual journals can post straight to control accounts** (1210/2110/1430/2210) without an open item (`bank-transactions.ts:563`, `journals.ts:124-155`) → AR/AP ageing ≠ control account.
4. **VAT 201 misses VAT not linked to a document** (bank-categorised or manual lines) and the "unlinked" warning nets to zero when a VAT settlement is in the period (`vat201.ts:171-177`).
5. **Inbox confirm drops the FX rate and due date** (`inbox.ts:569-584`, `:551`): non-AED bills default to rate 1.0; a missing invoice date silently becomes today.
6. **Nothing checks control account vs open items** (seed data shows AR control 210.00 vs ageing 0.00 because DESERT sales were seeded as raw journals — seed issue, `db/17-books-seed.sql`).
7. Partly recoverable bills can inflate VAT 201 box 9 (`vat201.ts:150-155`); posting journal + open item in two transactions (`documents.ts:930` then `:932+`); 1-fil FX rounding gap between open item and journal; ageing hard-codes advance codes 2320/1410.

## 4. UI: our screens vs the reference

| Area | Ours today | Target (AI Accountant pattern) |
|---|---|---|
| Upload | native file picker, toast only, formats differ per page, no size hint | one upload modal: drag/browse, stated formats + 25 MB limit, sample XLSX template, per-file progress, minimisable |
| Status | chips; most lists don't refresh | *Uploads* tab with live status (Queued → Extracting → Needs review / Failed), search, filter, size, pagination |
| Review queue | ‹ › + J/K; *Approve & next* at the bottom of a long scroll | position "n of m" + primary *Approve & next* and Delete in the header |
| Split view | yes, PDF 55 %, form ~520 px | PDF ~45 %, sidebar collapsed on review, 3 field columns on wide screens, secondary sections collapsible |
| Bill from list | opens a drawer without the PDF | opens the full split review; drawer kept for posted documents |
| Statements detail | single column, no source file | source file beside the lines |

## 5. Plan (in order)

1. **Correctness first (money):** FX rate on bank and inbox postings; reverse-charge open item; block control accounts outside settlements; VAT 201 unlinked VAT; control-vs-open-items check on Health/issues; atomic post.
2. **Ingestion wiring:** OCR for images; use OCR text in field extraction; XLSX in books; guard parsers; set `extracting`/`failed`, retries, timeout, stuck-job recovery, page cap, size/type limits; pass `intendedType`; one text-layer rule; preload models.
3. **Intake UI:** upload modal; Uploads tab with polling; header *Approve & next*; wider form; full-page review from Purchases/Sales; zoom %; statement source pane.
4. **Measure, then decide D2/D3:** run 50 real (synthetic-approved) scanned bills, record field accuracy per field; add Textract/LLM only where docTR + rules fall short.

Owner decisions needed: data residency for any cloud OCR/LLM (D2/D3); fix the DESERT seed so sales are real documents (migration/seed change).
