# arnibooks — Addendum prompts: Extraction engine + Output packs (VAT working & Financial Statements)

Two additions to the Phase 0–7 prompts:
- **Addendum A — Extraction engine** → run as part of Phase 1 (replaces the OCR lines in Phase 1 §1).
- **Addendum B — Output packs (XLSX + PDF)** → B1 (Financial Statements pack) runs with Phase 6; B2 (VAT working pack) runs as
  its own phase after Phase 6 (needs VAT codes from Phases 1–4).

Put the two reference files in the repo (anonymised copies only — replace client/customer/vendor names and TRNs with dummies
before committing):
- `docs/reference/outputs/vat-working-reference.xlsx`  (from "VAT Working – WelthPoint – April–June 26")
- `docs/reference/outputs/financial-statements-reference.pdf` (from "Frontier – Financial Statement for DEC 25")

Also update the MASTER CONTEXT OCR line to:

```
- Extraction: text-layer PDFs/CSV/XLSX via pdfplumber/PyMuPDF (no OCR). Scanned PDFs and images via docTR (local,
  Apache-2.0), behind the `Extractor` interface; EasyOCR as optional fallback for Arabic-only docs. No external OCR/LLM
  APIs until PORTAL_SECURITY_STATUS=PASS; an LLM extractor may be added later behind the same interface.
```

---

## ADDENDUM A — Extraction engine

```markdown
# Addendum A: Document text & field extraction engine (Python worker)

Goal: turn any uploaded document into structured, confidence-scored data that the review screens and posting logic use.
Accuracy over speed. Nothing extracted posts without human confirmation when confidence is below threshold.

## 1. Pipeline (worker job per document)
1. Store file (MinIO, sha256 dedupe) → sniff type (PDF / image / CSV / XLSX).
2. PDF: check text layer per page (pdfplumber/PyMuPDF). Page has text → text-layer route. No/garbled text →
   rasterise (300 dpi) → OCR route. Mixed PDFs handled per page.
3. Image (jpg/png/heic): deskew, denoise, contrast, perspective fix (OpenCV) → OCR route.
4. OCR route: docTR (db_resnet50 + crnn/parseq, CPU OK) → words with bounding boxes + confidence. EasyOCR fallback when
   docTR confidence is low and Arabic script is detected.
5. Layout: rebuild lines and tables from word boxes (column clustering by x-position; pdfplumber table finder for text PDFs).
6. Classify document type: sales invoice | purchase bill | receipt | bank statement | card statement | gateway statement |
   trial balance | other. Rules first (keywords "TAX INVOICE", "BILL", "ACCOUNT STATEMENT", "CREDIT STATEMENT", IBAN pattern,
   column headers), score + confidence; low confidence → user picks.
7. Field extraction (deterministic, per doc type) → normalised JSON + per-field confidence + source location (page, bbox)
   so the review UI can highlight where each value came from.
8. Validation + cross-checks (below) → status: ready | needs_review | failed. Store raw text, word boxes, JSON, version of
   extractor used.

## 2. Fields per doc type
- Invoice/bill/receipt: supplier name, supplier TRN (15 digits, starts 100), customer name + TRN, invoice no, invoice date,
  due date, currency, line items (description, qty, rate, VAT %, VAT amount, line total), subtotal, VAT total, grand total,
  balance due, place of supply / emirate, "Government fee"/disbursement markers, credit-note marker.
- Bank/card statement: bank, account holder, account no, IBAN(s) (split multi-account statements), currency per account,
  period from/to, opening/closing balance, transactions (date, value date, description, debit, credit, running balance,
  reference). Card: statement period, credit limit, previous balance, purchases, payments, interest/fees, total due, due date.
- Gateway (Stripe CSV / generic CSV/XLSX): column-mapping profiles saved per source; Stripe preset.
- Trial balance: account code/name, debit, credit (opening balances import).

## 3. Parsing helpers
- Amounts: "1,234.56", "(1,234.56)", "1.234,56", "AED 1,234", "-1,234.56 Dr/Cr" → integer fils + sign. Never floats.
- Dates: dd/mm/yyyy (UAE default), dd-MMM-yyyy, yyyy-mm-dd, "24 Aug 2026"; ambiguous dd/mm vs mm/dd resolved per source
  profile and by statement period.
- Arabic-Indic digits → ASCII. Bilingual lines: keep English text, ignore duplicated Arabic labels.
- TRN, IBAN (mod-97 check), invoice number patterns; currency codes; emirate names + free zones (map Meydan, RAKEZ, IFZA,
  DMCC, DSO, etc. to their emirate).

## 4. Validation (each failure lowers confidence and is shown in review)
- Invoice: Σ lines = subtotal; subtotal + VAT = total; VAT ≈ 5% × taxable (±0.01 per line rounding) unless zero/exempt;
  TRN format valid; date within/near period; duplicate (supplier + number + amount).
- Statement: opening + Σcredits − Σdebits = closing (per account); running balance continuity row by row (detects missed/
  misread rows); dates within period; no duplicate rows.
- Company match: our company's TRN/IBAN/name must appear (as customer on bills, as supplier on sales invoices, as holder on
  statements); otherwise → Unassigned inbox.

## 5. Source profiles (learning per layout)
- A "profile" per issuer layout (e.g. "Wio statement v1", "Zoho invoice template", "ENBD card statement"): anchors/regions,
  column positions, date format. Auto-created when a user corrects fields on a new layout; reused next time → higher
  confidence. Profiles are data, not code.

## 6. Review UI (used by Phase 1 inbox)
- Split view: document preview with highlighted boxes ↔ extracted form. Low-confidence fields amber, failed validation red.
- Statement review: table of extracted rows with running-balance check column; edit/insert/delete rows; re-check button.
- "Save as profile" on correction.

## 7. Quality bar & tests
- Fixture set (synthetic, committed): ≥ 10 text PDFs of varied layouts, ≥ 5 scanned/photographed images (generated by
  rendering synthetic PDFs to images with noise/rotation), 3 bank statement layouts incl. multi-IBAN + bilingual,
  1 card statement, Stripe CSV.
- Metrics script `scripts/extraction-eval.ts|py`: field-level precision/recall per doc type against ground-truth JSON;
  targets: text PDFs ≥ 99% on amounts/dates/TRN; scanned ≥ 95% with all misses flagged as low confidence (no silent errors).
- Statement balance check must catch any dropped row in tests.
- Local real-folder eval via lab script only (gitignored output).
```

---

## ADDENDUM B — Output packs (XLSX + PDF)

```markdown
# Addendum B: Output packs — Financial Statements pack and VAT Working pack, each as XLSX and PDF

Reference files (anonymised) in docs/reference/outputs/. Match their structure and look closely; improve where noted.
Both packs are generated ONLY from posted ledger data (+ VAT codes on journal lines), go through the existing release-pack
flow (prepare → approve by a different user → download with MFA), are versioned, hashed, and marked STALE if any upstream
posting changes the period.

## Common rules
- Two formats from the same data model: XLSX (exceljs, LIVE formulas so accountants can audit, e.g. SUMIF/SUBTOTAL like the
  reference) and PDF (server-side HTML → PDF via Playwright/Chromium, A4 portrait, Arnifi-branded header/footer, page
  numbers "Page x of y", company name/address/emirate on every page).
- After building the XLSX, recompute every formula cell in our code and assert it equals the system value (no #REF!,
  no #DIV/0!, no blank lookups). Fail the export otherwise.
- Amounts AED with 2 decimals, thousands separators, negatives in brackets, "–" for nil.
- Preparer, approver, prepared date, version and data hash in the footer / a "Cover" sheet.

## B1. Financial Statements pack (with Phase 6)
Structure to match the reference PDF (company header block; "(All amounts in AED)"; Particulars | Note | As at …):
1. Balance Sheet as at <date>
   I. EQUITY AND LIABILITIES
     (1) Shareholders' Funds: (a) Share Capital (b) Reserves and Surplus → Total
     (2) Non-Current Liabilities (e.g. long-term loans, EOSB provision)
     (3) Current Liabilities: (a) Trade Payables (b) Other Current Liabilities (expenses payable, VAT payable…)
         (c) Short-term provisions → Total
     TOTAL EQUITY AND LIABILITIES
   II. ASSETS
     (1) Non-Current Assets: (a) Fixed Assets (i) Tangible (ii) Intangible → Total
     (2) Current Assets: (a) Inventories (b) Trade Receivables (c) Short-term Loans and Advances (incl. shareholder
         current account) (d) Cash and Bank Balances (e) Other Current Assets (prepaid, VAT receivable) → Total
     TOTAL ASSETS (must equal TOTAL EQUITY AND LIABILITIES — export blocked otherwise)
2. Statement of Profit and Loss for the period/year ended <date>
   I. Revenue from Operations · II. Other Income · III. Total Revenue · IV. Expenses (Employee Benefit, Finance Costs,
   Depreciation & Amortisation, Other Expenses) · Total Expenses · V. Profit/(Loss) before Tax · VI. Tax Expense
   (Corporate Tax) · VII. Profit/(Loss) for the Period.
3. Statement of Cash Flows (indirect) — NOT in the reference; add it in the same visual style.
4. Statement of Changes in Equity (share capital, retained earnings: opening, profit/loss, dividends/drawings, closing).
5. Notes to the Financial Statements: one numbered note per line that has a Note no., listing the underlying accounts
   (e.g. Note 13 Other Expenses → each expense account with amount, Total). Notes numbered automatically in order of
   appearance; Note 2 Reserves = Opening + Profit/(Loss) for the year = Closing; fixed-asset note shows cost, additions,
   disposals, accumulated depreciation, net book value.
- Options: comparative column (previous period) on/off — default ON when prior-period data exists; period = month /
  quarter / year / custom; signature block (Director / Prepared by) on the last statement page.
- Mapping: driven by the COA `statement_line` + `note_group` fields, editable in Settings (so each line/note is configurable,
  not hard-coded). Any posted account not mapped → export blocked with a list.
- XLSX layout: sheets "Balance Sheet", "Profit and Loss", "Cash Flow", "Changes in Equity", "Notes", "Trial Balance"
  (supporting), "Cover"; statement cells are formulas referencing the Trial Balance / Notes sheets.
- Fix vs reference: the reference has no comparatives, no cash flow and no equity statement, and a misaligned note table
  (Note 13) — ours must be consistent.

## B2. VAT Working pack (after Phase 6)
Per company × VAT return period (monthly or quarterly per company profile). Sheets to match the reference XLSX:
1. "Checklist" — Sr. No. | Check Point | SPOC | Status (Done / NA / Pending) | Remarks. Seed with the reference's 22 check
   points (Tally-specific wording generalised to "ledger"), editable list per firm; each check can be auto-evaluated where
   possible (e.g. "RCM payable = RCM receivable", "input reversal for vendor dues > 6 months", "credit notes treated",
   "free zone supplies reported", "advances reported") with the system result shown next to the manual status.
   Column header shows the return period (the reference wrongly shows 01-Feb-2025).
2. "Observation" — two tables: (a) Requirements/queries for the client (e.g. "Place of supply required for: <customers>"),
   auto-populated from data gaps; (b) Observations with status (PENDING/RESOLVED), editable in the app, carried
   period-to-period until resolved.
3. "VAT RETURN" — "VAT Return Period: dd/mm/yyyy – dd/mm/yyyy"; Boxes exactly per FTA VAT201:
   1a–1g standard-rated supplies by emirate (Amount, VAT, Adjustment), 2 tourist refunds, 3 reverse charge supplies,
   4 zero-rated, 5 exempt, 6 goods imported, 7 adjustments to goods imported, 8 totals;
   9 standard-rated expenses, 10 reverse charge supplies (3+6+7), 11 totals;
   12 total due tax, 13 total recoverable tax, 14 payable/(refundable). Formulas = SUMIF over the Sales/Input sheets
   like the reference, by Place of Supply emirate and Voucher Type.
4. "Sales" — company name/address header, "Sales Account", "Basis: Accrual"; SUBTOTAL row; columns: Date | Invoice No. |
   Customer Name | Customer TRN | Voucher Type (Taxable Sales / Zero-Rated / Exempt / Out of scope / Credit Note) |
   Place of Supply (emirate) | Invoice Value | Taxable Value | VAT | Rate | Currency + FX rate | Remarks; Total row.
5. "Input Purchase" — "Purchase Account", "Basis: Accrual"; columns: Date | Particulars (supplier) | Supplier TRN |
   Description | Voucher Type (Input / RCM / Blocked / Non-recoverable) | Invoice No | Rate Check | Invoice Value |
   Taxable Value | Input VAT | Remark (verified / query); SUBTOTAL + Total.
6. "Summary" — Taxable Sales, Zero-Rated Sales, RCM (output) | Input, RCM (input) | Net Payable/(Refund) — with
   working formulas (the reference's Summary is broken with #REF! — ours must compute).
7. "Reconciliation" (new): VAT per return vs VAT control accounts in the ledger (Output VAT, Input VAT, RCM) — difference must
   be 0 or explained; Sales per VAT vs revenue per P&L for the period, with reconciling items.
- PDF version: VAT RETURN box summary page + Summary + Checklist + Observations (Sales/Input registers as appendix tables).

Validation gates (block export, show reasons) — the reference file contains each of these errors:
- Every sales row has Voucher Type and Place of Supply (emirate) for standard-rated supplies; free-zone names (Meydan,
  RAKEZ, IFZA…) mapped to their emirate — otherwise the row silently drops out of Box 1 SUMIFs.
- Emirate values normalised (no trailing spaces, e.g. "Sharjah " vs "Sharjah").
- Exports/zero-rated rows tagged so Box 4 picks them up; foreign-currency rows converted at stored rate.
- Rate check: VAT/Taxable must be 5% (±rounding) for standard rows; 0 for zero/exempt; flag otherwise
  (e.g. bank-fee row with taxable 21 and VAT 1).
- Duplicate invoice numbers per supplier flagged (reference has INV-003174 twice with different amounts).
- Input VAT claimed only with supplier TRN; unclear VAT rows ("clarify whether VAT charged") block until resolved.
- Every "Pending" checklist item and open observation must be resolved or explicitly accepted by the approver.
- Box 14 = Σ output VAT − Σ recoverable input VAT, and equals the ledger VAT control balance movement.

Tests:
- Golden: build an anonymised fixture equivalent to the reference quarter (synthetic names), hand-computed boxes in a
  fixture; generated XLSX re-opened, formulas evaluated (e.g. via a formula engine or LibreOffice headless recalculation),
  values compared cell-by-cell to the expected; PDF text extracted and key totals asserted.
- FS pack golden: companies A/B/C year-end — BS balances, P&L/notes tie, CF ties to cash, equity statement ties to BS.
```
