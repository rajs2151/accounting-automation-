# NEXT TASK — ING-2 (extraction that works on real bills) + ING-3 (intake & review UI)

Owner: Raj. Branch: `feat/books-phase1` (pull first; base ≥ fbb81c3). Reference: `docs/plan/ingestion-review-and-decisions.md`.
Commit order: **ING-1b** (atomic journal + open item, already written) → **ING-2** → **ING-3**. One commit each, each fully green
(typecheck, eslint 0 errors, full unit suite, worker pytest, `next build`, local e2e). Fix code, never tests or goldens.

---

## 0. Real documents from now on (owner decision 2026-10-07)

The owner will test with **real bills, invoices and bank statements on his own machine**. That is allowed, with these rules:

- **Never commit a real document** or anything derived from one (text, screenshots, extraction JSON, filenames, TRNs, IBANs,
  amounts). Real files live only in MinIO and in a gitignored local folder: add `/real-docs/` and `/lab-out/` to `.gitignore`.
- **Tests, fixtures, e2e and screenshots stay synthetic.** If a real file exposes a bug, reproduce it with a synthetic fixture
  that has the same layout/property (scanned, rotated, 2-column, Arabic, …) and commit that.
- **Do not remove or weaken the security gate** (`assertSyntheticTenant`, `PORTAL_SECURITY_STATUS`, RLS, dual control).
  The gate is per company (`clients.is_synthetic`), not per file — real files can already be uploaded to a synthetic-flagged
  company locally. If the owner wants a company marked real, he sets `PORTAL_SECURITY_STATUS=PASS` in his own local env; do
  not change the committed default.
- Real files never leave the machine: no cloud OCR / LLM calls (Textract/AI stays out of scope — data residency undecided).
- Identity is still a cookie user-picker, so keep the app bound to 127.0.0.1.

---

## ING-2 — make extraction actually fill the fields

**Symptom (owner's screenshot, real scanned tax invoice "INV-0191"):** review page shows Invoice date "—", one line item whose
description is the *file name*, Net 0.00 / VAT 0.00, Grand total "—", flags *No Rule Match · Company mismatch · Unassigned ·
Low Confidence Classification*, and it was classified as a **Sales invoice** although neither party on it is the company.

**Root causes already identified (fix all, with file:line in the doc §2):**
1. Scanned-PDF OCR text never reaches field extraction: `invoice_generic.py:106` extracts from the text layer only, and the OCR
   fallback reads `extraction.raw_pages`, which doesn't exist (`extraction/__init__.py:289`). → Return per-page text from
   `extract_file` (text layer or OCR) and feed **that** to `extract_invoice_fields`, with OCR word boxes for highlights.
2. Images (PNG/JPG/JPEG/HEIC) are decoded as UTF-8 (`invoice_generic.py:101-103`) → route every image through OCR.
3. XLSX/XLS/CSV in the books pipeline: parse directly with the existing reader (`extract.py:82-145`), never OCR.
4. Card-statement PDF crash (`card_generic` decodes PDF bytes) and unguarded `parse` (`extraction/__init__.py:183`) → guard
   every parser; a parser exception becomes a flag on the item, not a dead job.
5. Classification: pass `intendedType` / `userDocType` from the upload to the worker (Purchases page → purchase bill). When the
   company's own name/TRN is on **neither** side, don't default to `sales_invoice`: mark it `needs_review` with a clear
   "Which side is your company on?" flag; when the company is the **buyer** (Bill To / customer TRN) it is a purchase bill.
6. One "page has a text layer" rule (`extract.py:417-426` vs `pdf_words.py:11-18`); don't OCR digital pages that have text.
7. Load docTR/EasyOCR models at worker start (log warm-up time), not on the first scan.
8. Job lifecycle: set inbox item `extracting` when claimed and `failed` (with a readable reason) on error; per-job timeout,
   max 3 attempts with backoff, recovery of jobs stuck in `running`, page cap (e.g. 50 pages). A migration for an attempts
   column is allowed — own file, listed in STATUS for owner review, no RLS change.
9. Upload limits on the books routes: 25 MB per file, one accepted-types list shared by server and UI
   (PDF, PNG, JPG/JPEG, HEIC, XLSX/XLS, CSV); reject others with a readable message.
10. Review page fallbacks: never use the file name as a line description; an empty extraction shows empty, clearly-marked
    fields ("Not found — enter it"), not 0.00 / "Off by 0.00".

**Field accuracy target (measure on synthetic fixtures of each kind):** vendor/customer name, TRN, invoice number, invoice
date, due date, currency, subtotal, VAT, total, and line items (description, qty, rate, net, VAT code). Add fixtures:
scanned 1-page tax invoice, phone photo (JPG, skewed), 2-page digital invoice, XLSX bank statement, bilingual EN/AR invoice.
Unit tests use a **mocked OCR result** (cloud can't download docTR weights); the owner runs real OCR locally.

**Diagnostics for the owner (local only, never committed output):** a script `scripts/lab/extract-one.ts` (or extend
`lab:folder`) that prints, for one file: detected type + confidence, per-page method (text/OCR) and timing, raw text excerpt,
extracted fields with confidence, and flags. Output to `/lab-out/` (gitignored).

**Done when** the owner's scanned invoice type fills date, number, both parties, TRN, lines and totals on the review page,
and STATUS records measured timings (digital / scanned page / image) on his machine.

---

## ING-3 — intake & review UI (layout pattern from AI Accountant; our names, colours, wording)

The owner's complaint: our review screen feels cramped and less clean than the reference, which gives the form a large,
calm working area. Current facts: app sidebar 256 px stays open, PDF pane 55 %, form ~520 px, flag chips wrap in a row above,
"Confirm fields" and "Approve & next" live at different places, the queue position is unclear.

1. **Upload dialog** (`src/components/books/upload-dialog.tsx`, shared by Upload button, Inbox, Sales, Purchases, Statements):
   drag & drop or browse, multiple files, stated formats + 25 MB limit, optional "Document type" (auto / sales invoice /
   purchase bill / receipt / bank statement / card statement), per-file progress bars (XMLHttpRequest for upload progress),
   per-file result (uploaded / duplicate / rejected with reason), can be minimised to a corner tray while uploading,
   link to a sample XLSX template for bank statements.
2. **Uploads tab** on Inbox, Sales and Purchases: file name, size, type, uploaded at, uploaded by, status chip
   (Queued → Extracting → Needs review / Ready / Failed — with reason and Retry), search, status filter, pagination,
   auto-refresh every ~3 s while anything is Queued/Extracting (reuse the Statements page loop).
   Flow: Uploads → Needs review → All documents.
3. **Review page = full working screen** (`src/app/books/inbox/[id]/page.tsx`):
   - Auto-collapse the app sidebar on this route (icon rail), restore on leave.
   - Header row: ‹ Back · file name · "n of m to review" with ‹ › · status · ⋯ (Retry extraction, Delete/Discard) ·
     primary **Approve & next** (secondary: Save draft). One primary button only.
   - Document pane ~45 % default (draggable 30–70 %, remembered), show zoom %, fit width / fit page, page thumbnails,
     field highlight boxes (keep ours — they're better than the reference).
   - Form pane ~55 %, grouped cards with generous spacing: **Party** (name dropdown with create-new, TRN, address, place of
     supply), **Document** (type, number, date, due date, currency + FX rate when not AED), **Lines** (table: description,
     account, qty, rate, VAT code, net, VAT), **Totals** (computed vs printed, difference only when non-zero), then
     collapsible **Payments**, **Journal preview**, **VAT**. Two field columns, three on ≥1600 px.
   - Flags become one compact "3 things to check" summary with a popover list (plain English, each linking to the field),
     instead of a row of chips.
   - Keyboard: J/K next/previous, ⌘/Ctrl+Enter approve & next.
4. **Sales / Purchases rows open the full review page** (drawer stays for posted documents only).
5. **Statements detail**: source file beside the lines with the same splitter.
6. **Shell fixes seen in the screenshot:** "Working as" select shows a user UUID — give the Base UI Select `items` so it shows
   the name; top bar "Hi Books" uses the display name properly.
7. Visual polish across the intake screens: one spacing scale, max content width on very wide screens for list pages,
   consistent empty states, no horizontal scroll at 1280 px, and a 1440 px and 1920 px screenshot pass.

Do not copy AI Accountant's or CrossVal's names, logos, colours or text (`.cursor/rules/arnibooks.mdc`).

---

## Report back in STATUS

Per slice: gates (numbers), what's done / not done, any migration (for owner review), and for ING-2 the measured timings
and which field types still miss on the owner's real files (describe the layout, never paste real content).
