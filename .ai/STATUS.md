# arnibooks - Project status (maintained by the AI loop + reviewer)

## Now
- Phase: **ING (ingestion review)** on feat/books-phase1 — after Phase 7
- Current task: **2nd-review Phase 2** (page consistency) closed; next = Phase 3 coverage audit (report-only)
- 2026-10-08: **2nd-review Phase 2** (no migration; no RLS)
  - DONE: dashboard documents-to-review SoT + filtered hrefs (`inbox-classify`); Inbox confidence/type/dupes/tooltips
  - DONE: Sales/Purchases tab deep-links + Total column + subtitle parity; statements `?status=`
  - DONE: Parties Zone/VAT/Terms create+edit, TRN validation, search, balance column
  - DONE: Banking currency/cash-count/setup; Transactions “Bank accounts”; gateway Stripe ready without printed balances
  - DONE: FA blank defaults, disable Run with 0 assets, catch-up copy, bill-first for VAT, dd/mm/yyyy
  - DONE: Health Overview tab, tap info, Not enough data reasons, hide DIO/collection when no inventory, monthly CF detail
  - DONE: Issues badge already merges close gates (`dashboard/issues`) — confirmed SoT with checklist
  - **Phase 2 results**

| # | Item | Status | Files / notes |
|---|------|--------|----------------|
| 6 | Inbox counts / confidence / type / dupes / tooltips | fixed | `inbox-classify`, dashboard hrefs, inbox page, statements filter |
| 7 | Sales/Purchases table parity | fixed | Gross→Total; period subtitle; `?tab=` |
| 8 | Parties Zone/VAT/Terms / TRN / search / edit / balance | fixed | parties.ts + page; `parties-trn.test` |
| 9 | Bank/cash UX, currency, Banking label, balance_history | fixed | banking/transactions UI; worker gateway ready when account linked |
| 10 | Fixed assets UX / catch-up / dates | fixed | FA page; catch-up already in `depreciationDueThisPeriod` |
| 11 | Health KPIs / service hide / vs prior / Overview | fixed | health page MetricCard |
| 12 | Issues badge = checklist source | fixed | `listBooksIssuesMerged` shared by badge API + month checklist count |

- 2026-10-08: **2nd-review Phase 1** (db/65 AR seed OI + waive dual-control; no RLS change)
  - DONE: Desert Falcon May AR → sales invoice + open item (GL unchanged); hard-block **2220**; AR/AP close gate
  - DONE: money labels without "fils"; Health/FA copy; structured amounts on drift issues
  - DONE: VAT gate `not_set_up` when emirate/period unset; inbox_unreviewed blocking; statement coverage only if set up + activity/balance; recon no double-count; waive request→confirm dual-control + per-account columns; Exceptions + detail expander
  - DONE: due date from party terms; default issue date today/open period; Receipt disable at 0 / no party preselect
  - PENDING owner: VAT on advances design (see Known issues); sequential period-lock rule (propose only)
  - **Migration proposed:** `db/65-books-ar-seed-and-waive.sql` — apply to local/dev DB (tests apply all `db/*.sql`)
  - **Phase 1 results**

| # | Item | Status | Files / notes |
|---|------|--------|----------------|
| 1 | AR 1210 vs open 0 | fixed | Seed backfill INV+OI; close `ar_ap_tieout`; 2220 forbid; issues already had drift |
| 2 | fils in display | fixed | `money-display`; dashboard/health/FA |
| 3 | Close false passes / waive / UX | fixed | VAT not_set_up; inbox gate; coverage; dual waive; Exceptions |
| 4 | Period/date risks | fixed (order = decision) | due date + default issue date; **propose** sequential monthly lock — not enforced |
| 5 | Advances | verified + UI | 2320 OK; VAT TBD; Record disabled at 0; no preselect |

- Prior: **Phase 3–4 screenshot review bugs** closed; VAT return *posting* still pending owner review
- 2026-10-08: **Phase 3–4 review-bug fixes** (no migration; no RLS)
  - DONE: report basis labels (month / FY / range / as-of) + top-bar override indicator on FS/TB/Day book/Ageing
  - DONE: P&L always emits section headers; chart only when ≥3 columns; expenses series matches table (incl. PL_other)
  - DONE: BS Total liabilities + Total L+E; equity flatten; Current year profit presentation
  - DONE: shared `REPORT_TABS` / `BOOKS_NAV_GROUPS`; Company health **Soon**
  - DONE: Close Lock disabled reason + Checklist item copy; plain-English bank migration errors
  - DONE: issues badge popover with deep links; bank statements card instrument + cash n/a
  - DONE: Journals Columns picker + sticky Date/Voucher/Status
  - PENDING (owner review): VAT return *posting* generator (Phase 2 item 9) — draft + seed warn only
  - **Phase 3–4 results**

| # | Bug | Status | Files / notes |
|---|-----|--------|----------------|
| 13 | Basis labels month vs FY YTD | fixed | `report-basis`, FS/TB/Day book/Ageing subtitles |
| 14 | P&L sections + chart ≥3 + match table | fixed | `fs-report-tree`, `fs-chart-series`, chart gate in `fs-report-view` |
| 15 | BS totals / equity / CYE | fixed | `fs-report-tree` + CYE in engine |
| 16 | One period SoT + override | fixed | shell period SoT; override banner when range/FY/prior |
| 17 | Shared report toolbar/tabs | fixed | `books-nav` `REPORT_TABS` → `ReportsNav` |
| 18 | Close checklist + Lock reason + plain text | fixed | Close banner; Gate→Checklist item; api-error C2/C3 |
| 19 | Clickable issues badge | fixed | `issues-badge` dropdown + dashboard `#issues` |
| 20 | Bank statements card account definition | fixed | instrument label; cash `n/a`; required-only ok |
| 21 | Journals column picker / sticky | fixed | `data-grid` picker + sticky Date/Voucher/Status |
| 22 | Unify nav + Health placeholder | fixed | `books-nav` + Soon on Company health |

- 2026-10-08: **Phase 2 review-bug fixes** (db/64 compliance settings; no RLS change)
  - DONE: VAT return + dashboard due dates require establishment emirate AND return period; registration status + designated zone on VAT settings
  - DONE: JV-2026-0009 confirmed seed (`db/22` VAT return Jun 2026); warn on manual pure VAT settlement journals; VAT return *posting* generator deferred (draft exists) — **still pending owner review**
  - DONE: dual control honour `clients.require_dual_control` (default true); `posted_by` on post; Approved by on journal drawer
  - DONE: confirmed posted immutability (DB trigger) + reverse path + audit; unit coverage
  - DONE: SBR election + QFZP company settings; CT banner `noTaxDueRecorded` only when recorded
  - DONE: units `phase2-compliance.test.ts`
  - **Phase 2 results**

| # | Bug | Status | Files / notes |
|---|-----|--------|----------------|
| 8 | Block VAT return/due dates until emirate + period; TRN/reg/zone | fixed | `db/64`, `company-vat-settings`, `vat201`, `dashboard`, `vat-settings-section` |
| 9 | JV-2026-0009 manual VAT before period end | **pending review** | Seed in `db/22`. Warn on manual VAT settlement. Draft VAT201 exists; dedicated post flow not built — wait for OK |
| 10 | Maker-checker + show approver | fixed | `require_dual_control`, `posted_by`, journal drawer Approved by |
| 11 | Posted immutable + audit | fixed (confirmed) | Trigger + reverse + audit; unit in `phase2-compliance` |
| 12 | SBR assumed / no tax due | fixed | `sbr_elected` / `is_qfzp`; banner only zeros tax when recorded |

- 2026-10-08: **Phase 1 review-bug fixes** (no migration; no RLS; seed AR deferred)
  - DONE: shell `reloadPeriods` after Close/Settings lock/unlock/waive; Close empty-history copy when LOCKED without events
  - DONE: plain-English `c2_bank_accounts_migration_required`; month checklist soft-fails bank list (empty banks, Lock not blanked)
  - DONE: Receivables tile Outstanding + Overdue; AR/AP control-vs-open drift hint (open items ≠ GL 1210)
  - DONE: TB sticky footer outside scroll; hide-zero = closing net zero; checkbox “Hide zero closing balances”
  - DONE: Day Book particulars prefer memo → party → lead account → voucher no.; Journals `entryType` header/filter/CSV = Source
  - DONE: Working-as label never bare UUID when name exists; control shown for admin or Dev UI (development)
  - DONE: units `working-as-label`, `dashboard-money-labels`, TB hide-zero, day-book memo particulars, api-error C2
  - NOT DONE (owner decision): replace Desert Falcon seed AR bare journal with posted sales invoice + open item
  - **Phase 1 results**

| # | Bug | Verdict | Fix |
|---|-----|---------|-----|
| 1 | Lock vs Open across screens / Lock disabled | Real (stale shell + C2 soft-fail UX) | `reloadPeriods`; C2 message; checklist soft-fail banks; locked empty-history copy |
| 2 | Receivables 0 vs 1210 on TB | Real (open items vs GL) | Outstanding/Overdue + drift hint; seed AR deferred |
| 3 | TB footer overlaps last rows | Real | Totals outside scroll body |
| 4 | Hide-zero keeps settled VAT | Real (period movement HAVING) | Drop closing Dr=Cr=0; rename checkbox |
| 5 | Day Book particulars = lead account | Real | Prefer memo, then party, then lead, then voucher no. |
| 6 | Journals two “Type” columns | Real | `entryType` → Source (header/filter/CSV) |
| 7 | Working-as shows UUID | Real | Name · role label; admin or Dev UI only |

- 2026-10-08: **Snippet split** (db/63 inbox parent + page ranges; no RLS)
  - DONE: `splitInboxPdfSnippets` + `POST /api/books/inbox/:id/split-pages`; parent → `routed`; children share `file_id`
  - DONE: worker clips PDF pages for extract; remaps word-box pages to original; confirm copies page range to documents
  - DONE: review UI **Split by pages** (one range per page when pageCount ≥ 2); unit `inbox-split-pages.test.ts`
  - NOT DONE: auto-detect receipt boundaries; knowledge cards; email-in; Textract
- 2026-10-08: **ING-4e** weak real-docs fields (no migration; no RLS)
  - DONE: stacked VAT / Subtotal / Total; Bill From issuer; payment-favour fallback; vat=gross−net only when >0
  - DONE: bank FROM–TO / Statement Period / letterhead bank_name; stacked opening/closing (incl. integer amounts)
  - DONE: gateway Nomod path uses `extract_file` OCR; eval prefers account with balances + gateway/card doc types
  - DONE: unit `test_ing4e_weak_fields.py` + Wio/RAK header cases in `test_ing4c_statements.py`
  - Eval vs prior baseline (rates only): overall acc **0.61→~0.65**; vat **0.24→0.47**; issuer_name **0.12→0.29**;
    bank_name/period **0→0.33**; closing_minor **0→0.5**; supplier_name **0.4→1.0**; wio **0.33→0.58**
  - Still weak: Nomod OCR empty (acc 0); opening_minor; due_date; RAK opening window
- 2026-10-08: **Slice C polish** (db/62 review_later; no RLS change)
  - DONE: non-UAE purchase VAT → cost (never 1430); unit `non-uae-vat.test.ts`
  - DONE: inbox `review_later` status + `POST …/inbox/:id/review-later`
  - DONE: firm board `documentsToReview` column; settings CoA/parties CSV templates
  - DONE: purchases Outstanding covers unpaid; B6 From receipt CTA on Expenses
- 2026-10-08: **Slice B6** receipt → bank match or expense draft (no migration)
  - DONE: `addTransactionFromReceipt` + `POST /api/books/receipt-to-txn`; unit green
- 2026-10-08: **Slice B5** Golden v2 bank cases (no migration)
  - DONE: `fixtures/books-goldens/v2/` + `golden-v2.test.ts` (partial, 1:N, fee, card, Stripe netting, transfer)
- 2026-10-08: **Slice A** local real clients (no migration; no RLS change)
  - DONE: gitignored `docker-compose.override.yml` sets `PORTAL_SECURITY_STATUS=PASS` for web; committed compose + CI stay FAIL
  - DONE: `.env.example` documents PASS via override; security chip shows PASS (emerald) as well as FAIL
  - DONE: firm health + inbox routing include non-synthetic when PASS; unit asserts PASS allows real tenant
  - NOTE: owner-authorised local PASS only — not a signed portal security review for production
- 2026-10-08: **Real-docs eval** (owner files via Downloads → gitignored `/real-docs/`; rates only)
  - Labeled **25** files (24 scored; 1 stem fixed); layout_tags: arnifi_tax_invoice, arnifi_zoho_bill, bedouin_tax_invoice, wio_multi_account, rak_bank_statement, card_statement_pdf, stripe_balance_history_csv, stage_works_tax_invoice, nomod_scan_empty_text, financial_statement_skip
  - Overall: accuracy **0.61**, found_rate **0.76**, false_confidence_rate **0.086** (n=19) on 221 labeled fields
  - Stronger: bedouin_tax_invoice ~0.84; arnifi_tax_invoice ~0.72; issuer_trn/supplier_trn/customer_trn 1.0; gross/grand_total ~0.94
  - Weaker: bank_name/period_*/opening_minor/closing_minor ~0; vat ~0.24; issuer_name ~0.12; wio_multi_account ~0.33; nomod empty text
  - Baseline: `lab-out/eval-baseline.json` (gitignored)
- 2026-10-08: **ING-1c** closed (AR/AP control drift on Company Health)
- 2026-10-08: **ING-1c** AR/AP control vs open-items on Health (no migration; no RLS)
  - DONE: `controlVsOpenItemsDrift` helper; `listBooksIssues` refactored to share it
  - DONE: Health scorecard fields + critical insights (`ar_control_vs_open_items` / `ap_control_vs_open_items`)
  - DONE: scorecard cards + Debtors `health-control-drift-banner`
  - DONE: unit `control-drift.test.ts` + insights coverage
  - Gates: typecheck 0; unit 354p/0f/1s; e2e 11/11
- 2026-10-08: **ING-5** closed (5a–5c shipped)
- 2026-10-08: **ING-5c** owner how-to (no migration)
  - DONE: `docs/how-to/test-your-own-documents.md` (upload → Trace → reports checklist; real files stay in `/real-docs/`)
- 2026-10-08: **ING-5b** Trace tab + API + CLI (no new db migration; no RLS)
  - DONE: `src/server/books/trace.ts` + `GET /api/books/trace/:kind/:id` (document|inbox|bank-transaction)
  - DONE: `TracePanel` on inbox review, document review, bank txn drawer; `npm run trace`
  - DONE: unit `trace.test.ts`; Playwright Trace assert on scenario 1
  - Gates: typecheck 0; unit 352p/0f/1s; e2e 11/11
- 2026-10-08: **ING-5a** flow proof (no new db migration; no RLS)
  - DONE: fixtures `fixtures/extraction/ing5/` (generate.py + pdfs + ground_truth)
  - DONE: worker `test_ing5_fixture_extract.py`; unit `flow-e2e.test.ts` scenarios 1–10 + TB/FS/ageing/VAT/issues tie-outs
  - DONE: Playwright scenario 1 in `e2e/books-phase1.spec.ts` (upload → seed → confirm → Layla approve → exact fils)
  - Gates: typecheck 0; unit 351p/0f/1s; pytest 146p; e2e 11/11
- 2026-10-08: **ING-5 Gate 0** local DB migrations applied on compose `daftar` (db/35–61 incl. `books_bank_transactions` + `books_fx_rates`); Transactions page unblocked
- 2026-10-08: **ING-4** extraction accuracy — **4a–4d shipped**; owner real-docs eval pending
- 2026-10-08: **ING-4 Gate 0** worker pytest with S3 stand-in: **120 passed**, 0 failed (6 warnings)
- 2026-10-08: **ING-4d** checks + confidence + review expected-vs-read (no new db migration; no RLS)
  - DONE: `extraction/checks.py` invoice math / VAT 5% / TRN / statement balance + IBAN; fail caps conf ≤0.79
  - DONE: flags `code:expected=…|got=…`; review badges via `validation-flag-labels` (“expected X, read Y”)
  - DONE: pytest `test_ing4d_checks.py` + TS label tests
  - Owner: run `npm run extraction:eval -- --real-docs --compare`; paste layout_tag rates + weak tags into STATUS (no real values)
- 2026-10-08: **ING-4c** bank/card/XLSX pipeline (no new db migration; no RLS)
  - DONE: IBAN mod-97 (`iban_check`); skip BCF/page totals/repeated headers; signed amounts; multiline desc
  - DONE: XLSX deeper header scan + Arabic-Indic cells; `card_statement_pdf` partial parse + `card_pdf_partial` flag
  - DONE: pytest `test_ing4c_statements.py`; e2 bank suite green
  - Owner: re-run real-docs eval for statement layout_tags; STATUS rates only
- 2026-10-08: **ING-4b** invoice/bill pipeline (no new db migration; no RLS)
  - DONE: OCR word boxes merged into extract path (PDF points); auto-rotate 0/90/180/270 before deskew
  - DONE: `layout.py` lines/two-column/KV; `candidates.py` scored TRN/date/amount/currency; CN/DN/proforma flags
  - DONE: Arabic-Indic → ASCII in textnorm / money / fields; pytest `test_ing4b_invoice_pipeline.py`
  - Owner: re-run `npm run extraction:eval -- --real-docs --compare`; STATUS may cite layout_tag rates only
- 2026-10-08: **ING-4a** real-docs eval harness (no new db migration; no RLS)
  - DONE: `daftar.extraction.eval_metrics` + pytest; `scripts/extraction-eval.py --real-docs` → `/lab-out/`
  - DONE: label templates (fake values) under `fixtures/extraction/label-template*.example.json`
  - DONE: acceptance = owner labeled `/real-docs/`; no new synthetic golden requirement
  - Owner: copy templates → `real-docs/labels/<stem>.json`, run `npm run extraction:eval`, paste rates by layout_tag into STATUS
- 2026-10-07: **ING-3** intake & review UI (no new db migration; no RLS)
  - Gates: typecheck 0; eslint src+e2e 0 errors (7 pre-existing warnings in next build); unit 349p/0f/1s; pytest 120p; next build exit 0; local e2e 10/10
  - DONE: shared `UploadDialog` (DnD, progress, type, tray) on Inbox / Sales / Purchases / Statements / Banking / shell Upload
  - DONE: Inbox Uploads → Needs review → All; Sales/Purchases tab order + size/by/uploaded columns + 3s poll
  - DONE: full review chrome — sidebar auto-collapse, ~45% doc pane, Party/Document/Lines/Totals cards, flags popover, Save draft + Approve & next, J/K + Ctrl/⌘+Enter
  - DONE: draft Sales/Purchases → `/books/documents/[id]`; drawer posted only; statements source-file splitter; Working as / Hi display names
  - NOT DONE: 1440/1920 screenshot harness pass (optional; phase1 screenshots still captured in e2e)
  - NOT DONE: Textract / external OCR-LLM (blocked until security PASS)
- 2026-10-07: **ING-2b** extraction leftovers (no new db migration; no RLS)
  - DONE: company on neither party → `purchase_bill` @ 0.5 + `company_not_on_invoice` (stream B `e29c8e6`)
  - DONE: one usable text-layer rule (`page_has_usable_text_layer`) shared by extract / pdf_words / ocr_engine
  - DONE: review empty copy “Not found — enter it”; lines/totals never invent 0.00 / Off by 0.00
  - DONE: fixtures `phone_skew_01.jpg`, `xlsx/bank_statement_a.xlsx`; gitignore `/real-docs/` `/lab-out/`
  - DONE: `npm run lab:extract-one` → `/lab-out/` (owner measures digital/scanned/image timings locally)
- 2026-10-07: **ING-1b** atomic document journal + open item (no new db migration; no RLS)
  - Gates (shared with ING-2 ship): typecheck 0; eslint src+e2e 0 errors / 7 warnings (pre-existing); unit 346p/0f/1s; pytest 114p; next build exit 0; local e2e 10/10
  - DONE: approve posts journal + open item + document update in **one** approver transaction; draft discarded on failure
  - DONE: MONEY-6 happy path; MONEY-7 forces failure after journal post → no posted journal without open item, document stays draft
- 2026-10-07: **ING-2** extraction wiring (no new db migration; no RLS)
  - Same gates as ING-1b above
  - DONE: intendedType from inbox → worker payload / `books_inbox_items.intended_type`
  - DONE: inbox status `extracting` on start; retry with backoff; final failure → inbox `failed`
  - DONE: stuck `running` extract/classify jobs requeued (`requeued_stuck`, 20 min)
  - DONE: PNG/image always OCR → `raw_pages` → invoice fields (mocked OCR in pytest)
  - DONE: scanned PDF OCR page text fills invoice fields (invoice no + totals)
  - DONE: XLSX bank/tabular via `extract_file` without calling OCR
  - DONE: card-statement PDF no longer UTF-8-decoded / does not crash (`can_parse` 0; `card_pdf_not_csv`)
  - DONE: 25 MB upload cap + shared extension list (`books-upload.ts`) + UI `accept`; oversize rejected
  - DONE: page cap `BOOKS_EXTRACT_MAX_PAGES`; OCR model preload on worker start
  - DONE: pytest `test_ingestion_ing2.py` covers PNG mock OCR, scanned PDF fields, XLSX no OCR, card PDF, failed→inbox failed, stuck requeue; TS `books-upload.test.ts` covers >25 MB
  - NOT DONE: ING-3 upload + review UI (owner gate — do not start until review)
  - DONE: surface AR/AP control drift on Health (ING-1c)
  - NOT DONE: Textract / external OCR-LLM (blocked until security PASS)
- 2026-10-07: **ING-1 money correctness** on feat/books-phase1 (no new db migration)
  - Gates: eslint src+e2e 0 errors / 7 warnings (pre-existing); next build exit 0; local e2e 10/10; unit 341p/0f/1s; typecheck 0
  - DONE: exchange rate required on bank, receipt/payment and inbox postings; no 1.0 fallback for foreign currency (AED uses identity scale); bank recon still compares account-currency/original amounts (correct once journals store original + AED)
  - DONE: reverse-charge open item equals the amount credited to 2110 (net, not gross)
  - DONE: control accounts blocked on bank post without open-item settlement (staging to 1210/2110 allowed for match; categorise-only / bare category JV throws `control_account_requires_open_item`; manual journals throw `control_account_forbidden`)
  - DONE: control vs open-items check on the issues badge (and month checklist); also on Health (ING-1c)
  - DONE: VAT 201 unlinked VAT counted gross (settlement Dr 2210 ignored); fails VAT control close gate when boxes ≠ control movement
  - DONE: inbox confirm carries FX rate + due date; missing issue date errors (no silent "today")
  - DONE (completed in ING-1b): journal and open item written in one transaction
- 2026-10-07: **ING-1 review fixes** (stream B): the manual-journal control-account block broke two real flows — opening-balance import with AR/AP lines (now passes `allowControlAccounts`, it already matches party open items) and the Journals "VAT settlement" template (a journal whose every line is 2210/1430/2220/1440 is allowed; trade controls and mixed lines stay blocked). Close VAT gate movement now excludes settlement entries (lines on 2220/1440) so a quarter-end settlement doesn't fail Box 8/11 vs 2210/1430. Readable messages for `fx_rate_required`, `control_account_forbidden`, `control_account_requires_open_item`. New test `control-accounts-carveouts.test.ts`. Unit 338p/0f/7s; e2e 12/14 (2 MinIO-only).
- 2026-10-07: Phase 7 CLOSED (P7-1..P7-4) — Company Health + firm board; unit 336p/0f/1s; e2e 10/10
- 2026-10-07: P7-3+P7-4 PASS — scorecard, runway/profit tabs, insights, firm board
- 2026-10-07: P7-2 PASS — AR/AP trackers, DSO/DPO/CCC/collection strip, Debtors tab + GET /health/debtors; unit 324p/0f/1s; e2e 9/9
- 2026-10-07: P7-1 PASS — health summary (cash, avg CF, runway, L÷A) + /books/health Dashboard; unit 317p/0f/1s; e2e 9/9
- 2026-10-07: P6-4 PASS — comments/@mentions, CT estimate banner, SVG P&L chart, forecasts layer (db/61); unit 293p/0f/1s; e2e 8/8
- 2026-10-07: P6-3 PASS — gated FS Excel+PDF export (integrity + audit hash); unit 283p/0f; e2e 8/8
- 2026-10-07: P6-2 PASS — FS screens (P&L/BS/CF tabs) + drill reclass draft; unit 273p/0f/1s; e2e 8/8
- 2026-10-07: P6-1 PASS — FS engine P&L/BS/CF + period columns + integrity gates + report APIs (no UI); unit 247p/0f/1s; e2e 7/7
- 2026-10-07: P5-4 PASS — year-end close to RE + Golden v5 TB; TB as-of picker deferred (period picker covers)
- 2026-10-07: P5-3 PASS — FX rates + unrealised revaluation + close gate (db/59); push enabled per owner
- 2026-10-07: P5-2 PASS — fixed assets + straight-line depreciation + close gate (db/58); unit 240p/0f/1s; e2e 7/7
- 2026-10-07: P5-1 PASS — close checklist + waive/lock/unlock + changed-since-close (db/57); unit 237p/0f/1s; e2e 7/7
- 2026-10-07: P5-1 — books close checklist + waive/lock/unlock + changed-since-close (db/57)
- 2026-10-07: Phase 3/4 critical bugfixes (expenses double-post, dual-control, period/AED/VAT; accrual auto-reverse next month; sheet reset; draft auto-reverse; drawer race; expense VAT→VAT201)
- 2026-10-07: Phase 4 CLOSED (P4-1..P4-5)
- 2026-10-07: P4-5 PASS — reverse reason+date; drawer Reverse; immutability e2e
- 2026-10-07: P4-4 PASS — schedule/recurring/auto-reverse (1st next month); Entry n of N badge
- 2026-10-07: P4-3 PASS — Create Entry templates (accrual auto-reverse, prepayment asset warning, payroll)
- 2026-10-07: P4-2 PASS — SideDrawer Dr/Cr line cards, parent account, audit timeline + actor
- 2026-10-07: P4-1 PASS — Split(n), Expense voucher filter, reversed grey, Rules link, e2e chrome
- 2026-10-07: Phase 3 CLOSED + pushed; Phase 4 started
- 2026-10-07: Phase 3 pushed (`11d21bb` P3-1 · `020ffdb` P3-2 · `1fd17eb` P3-3) on feat/books-phase1
- 2026-10-06: P3-3 PASS — paid-from bank/card match (link before approve or later); no double journal
- 2026-10-06: P3-2 PASS — submit/approve/reject dual-control EXP journal
- 2026-10-06: P3-1 PASS — expenses draft schema + UI
- 2026-10-06: P2A-6 PASS — bulk preview/post, Rules page, transfer auto-link; Phase 2 Stream A closed
- 2026-10-06: P2A-5 PASS — materialize requires balance_ok; top-bar period shows label
- 2026-10-06: P2A-4 PASS — card repayment / gateway payout + group net-zero; Unmatched→post e2e
- 2026-10-06: P2A-3 PASS — bank rules (conditions→actions), preview, Rule: chip, create-from-txn
- 2026-10-06: P2A-2 PASS — weighted match scores, bands, reject memory, subset-sum bundle
- 2026-10-06: P2A-1 PASS — split allocations 1:N/N:1 + fees; unallocated=0; advance VAT TBD flagged
- 2026-10-06: C3-3 PASS — transfer pair link → one Contra (CV); dual-control post both sides.
- 2026-10-06: C3-2 PASS — 1:1 open-item match + dual-control post (RV/PY or category JV).
- 2026-10-06: C3-1 PASS — bank txns Needs Review / Ready / Excluded; categorize only (no journal post).
- 2026-10-06: C2-2 PASS — intended account on upload, IBAN≠account block, sample CSV, statement logs.
- 2026-10-06: C1b-2 PASS — apply customer advance on sales approve (optional, never default).
- 2026-10-06: C2-1 PASS — Banking page, coverage/gaps, setup gate, COA link.
- 2026-10-06: C1b PASS — sales Uploads/tabs parity + manual record reason gate.
- 2026-10-06: C1-3 PASS — Item/Accounting, Approve & Next, party mismatch, purchases tabs/bulk.
- 2026-10-06: E1d PASS (71cde5b) — confirm/UI never invent SR; block until VAT picked.
- 2026-10-06: E1c PASS (24a77ca) + UI-3-fix1 scroll/flags PASS (8e9b4f9). Queue:
  **C1b follow-up | polish backlog**
- 2026-10-05: E4 + E5 + UI-1..UI-4 PASS on feat/books-phase1 (pushed).
- 2026-10-05 16:50 owner decisions on E2: (1) ambiguous multi-IBAN activity -> two statements, both needs_review,
  attribute by position, flag account_attribution_ambiguous, never 'ready'; (2) bank ground_truth filled from
  generate_synthetic.py constants BANK_A/B/C (owner-approved ground_truth edit, those 3 files only).
- Done today: PYTEST-0 | E1 | E2 | E3 | E4 | E5
- Claude did directly (owner request 2026-10-05): login picker + synthetic owner Raj (db/31), worker NUL-safe text +
  garbled pages -> OCR (E3b), duplicate upload notice + per-company file hash (db/32), readable errors with ref,
  faster Docker builds, parallel typecheck, scripts/ai/test-files.ps1, scripts/dev-local.ps1, ~/.wslconfig
- 2026-10-05 13:xx owner decision: smaller one-layer tasks. DEMO-1 shelved on branch wip/demo-1-shelved (0f6cb7e,
  unverified; contains a rejected trigger-disabling hack in trial-balance.test.ts - never merge). Extraction redone
  the Addendum A way (worker = single extractor) as E1-E5. Task files wait in .ai/NEXT_TASK_*.md.
- Loop changes: scripts/ai/gates.ps1 (Cursor runs the same gates), pytest gate uses cached venv
  (scripts/ai/pytest-inner.sh), timeout no longer crashes the loop, .gitattributes forces LF for *.sh.
- Done: POC-001 PASS · VERIFY-S1 + VERIFY-S1-FIX1 PASS · C1-1 PASS | C1-2 PASS
- Owner gate: every slice boundary needs Raj's approval; loop never starts a new slice by itself.
- CEO demo build: tag demo-ceo-2026-10-05 (957529f) is what runs in the web container on :43123; db/26-28 applied to
  the dev DB (backup: C:\Users\Raj\arnibooks-backups\pre-demo-20261005.dump). Do NOT rebuild web before the demo.
- 2026-10-05 ~17:45: localhost updated to tag local-e2-2026-10-05 (E1+E2, worker+web rebuilt; db/29-30 applied;
  backup C:\Users\Raj\arnibooks-backups\pre-e2-20261005.dump). Demo build still tagged demo-ceo-2026-10-05.

## Queue (next tasks, in order - reviewer may refine)
1. Knowledge cards (suggest-only rules from corrections) — Phase 2+ brief needed
2. Email-in intake — after security PASS for real mail
3. Further Nomod/RAK/opening_minor extraction if still weak after 4e
4. Company A month-1 hand golden (owner); brand hex + font; B/C openings; expense receipt threshold
5. Optional: 1440/1920 screenshot harness; Textract/external OCR-LLM (blocked until signed production security PASS)

## Known issues / open decisions
- **VAT on customer advances (2nd-review item 5):** propose — on unmatched receipt Cr 2320 net + Cr 2210 VAT (gross÷1.05) when party taxable; store VAT on advance; reverse into invoice apply without double-count. **Do not build until approved.** Today: gross → 2320 only + memo flag.
- **Period lock order (2nd-review item 4):** propose — require prior month LOCKED before locking month N (same fiscal year); unlock of N invalidates readiness of N+1 until re-locked. **Not enforced yet.**
- **VAT return posting generator** (Phase 2 item 9): pending owner review — seed JV + draft VAT201 + warn on manual settlement only; do not auto-post from return until approved.
- Test (VERIFY-S1-FIX1 review): approver least-privilege test does not first prove Layla can SELECT the rows before showing DELETE/UPDATE change 0 rows - add a row-count check in a later task.
- Company A month-1 golden is PROVISIONAL - owner to supply hand-computed values (Claude offered to prepare).
- VAT on customer advances: policy TBD (not implemented).
- Expense receipt threshold: NULL until owner sets (do not invent default).
- Real reference file docs/reference/outputs/*.xlsx is gitignored; only anonymised copies may be committed.
- Pending inputs: brand hex + font; B/C opening balances.
- Polish shipped in Real-docs+A+B+C: Review later, paid/unpaid Outstanding, non-UAE VAT→cost, settings CSV templates, firm docs-to-review. Still deferred: knowledge cards, email-in, snippet split, stale extraction, E1b worker confidence.
- E1d closed (confirm never invents SR).

## Log
- 2026-10-08 | 2nd-review Phase 1 | PASS | db/65 AR OI + waive dual-control; close gates; money labels; VAT advances + period-order proposals pending
- 2026-10-08 | Phase 3–4 review bugs | PASS | items 13–22; VAT return posting still pending owner review
- 2026-10-08 | Snippet-split | PASS | db/63 + split API/UI + worker clip; unit 2p
- 2026-10-08 | ING-4e | PASS | weak-field extract + bank headers; eval acc ~0.65; unit green
- 2026-10-08 | Real-docs+A+B+C | PASS | eval rates in STATUS; local PASS override; B5/B6; polish db/62
- 2026-10-08 | ING-1c | PASS | AR/AP control drift on Health scorecard + insights; unit 354p e2e 11/11
- 2026-10-08 | ING-5c | PASS | owner how-to test-your-own-documents.md; ING-5 closed
- 2026-10-08 | ING-5b | PASS | Trace API/UI/CLI + unit + Playwright; unit 352p e2e 11/11
- 2026-10-08 | ING-5a | PASS | flow e2e 1–10 + worker extract + Playwright scenario 1; unit 351p pytest 146p e2e 11/11
- 2026-10-07 | ING-1b | PASS | atomic journal+OI + MONEY-7; pushed feat/books-phase1
- 2026-10-07 | ING-2 | PASS | extraction wiring + pytest 114; pushed feat/books-phase1; stop before ING-3
- 2026-10-07 | ING-2 review (stream B) | PASS | ING-1b atomic post OK (same pattern as settlements). Reran: unit 340p/0f/7s, pytest 113p + 4 OCR tests that need docTR/EasyOCR weight downloads (blocked in cloud; same 4 fail before ING-2). Fixed: invoice with the company on neither side was classified sales_invoice (owner screenshot) → now purchase_bill at 0.5 + `company_not_on_invoice` flag ("Your company isn't on this invoice — confirm sale or purchase"); `.gitignore` /real-docs/ /lab-out/. Still open from the ING-2 brief: one text-layer rule (extract.py vs pdf_words.py); review-page fallbacks (no file name as line description, empty fields not 0.00) → do in ING-3; `scripts/lab/extract-one` diagnostic for owner's real files.
(the loop appends one line per run: date | task | iteration | decision | run folder)
- 2026-10-04 15:53 | POC-001 | i1 | NEEDS_HUMAN_DECISION | .ai/runs/20261004-153155-POC-001-i1
- 2026-10-04 20:13 | POC-001 | i1 | PASS | .ai/runs/20261004-200719-POC-001-i1
- 2026-10-04 21:54 | VERIFY-S1-FIX1 | i1 | PASS | .ai/runs/20261004-214314-VERIFY-S1-FIX1-i1
- 2026-10-04 23:37 | C1-1 | i1 | FAIL | .ai/runs/20261004-232143-C1-1-i1
- 2026-10-04 23:52 | C1-1 | i2 | PASS | .ai/runs/20261004-233756-C1-1-i2
- 2026-10-05 00:17 | C1-2 | i1 | FAIL | .ai/runs/20261004-235830-C1-2-i1
- 2026-10-05 ~00:40 | C1-2 | i2 | KILLED (Claude Code stopped the loop: Windows RAM ~0.3 GB free). Cursor's uncommitted
  i2 fix left in src/server/books/inbox.ts + c1-validation.test.ts; scripts/_diag-tb-tmp.sh is a Cursor scratch file.
  Next: owner restarts loop (C1-2 i2 fix for case 7 re-routing), then swap in .ai/NEXT_TASK_DEMO-1.md.
- 2026-10-05 10:57 | C1-2-FIX1 | i1 | PASS | .ai/runs/20261005-104227-C1-2-FIX1-i1
- 2026-10-05 12:05 | DEMO-1 | i1 | FAIL | .ai/runs/20261005-105927-DEMO-1-i1
- 2026-10-05 15:14 | TEST-ISO-1 | i1 | FAIL | .ai/runs/20261005-145854-TEST-ISO-1-i1
- 2026-10-05 15:25 | TEST-ISO-1 | i2 | FAIL | .ai/runs/20261005-151433-TEST-ISO-1-i2
- 2026-10-05 15:32 | TEST-ISO-1 | i3 | PASS | .ai/runs/20261005-152522-TEST-ISO-1-i3
- 2026-10-05 15:46 | PYTEST-0 | i1 | PASS | .ai/runs/20261005-153350-PYTEST-0-i1
- 2026-10-05 16:04 | E1 | i1 | FAIL | .ai/runs/20261005-154808-E1-i1
- 2026-10-05 16:17 | E1 | i2 | PASS | .ai/runs/20261005-160417-E1-i2
- 2026-10-05 16:45 | E2 | i1 | NEEDS_HUMAN_DECISION | .ai/runs/20261005-161902-E2-i1
- 2026-10-05 17:16 | E2-FIX1 | i1 | FAIL | .ai/runs/20261005-164758-E2-FIX1-i1
- 2026-10-05 17:39 | E2-FIX1 | i2 | PASS | .ai/runs/20261005-171632-E2-FIX1-i2
- 2026-10-05 18:16 | E3 | i1 | FAIL | .ai/runs/20261005-175649-E3-i1
- 2026-10-05 18:35 | E3 | i2 | PASS | .ai/runs/20261005-181636-E3-i2
- 2026-10-05 22:19 | E4 | i1 | NEEDS_HUMAN_DECISION | .ai/runs/20261005-215737-E4-i1
- 2026-10-05 | E4 | PASS (c7b68ea, 3cd37f3) | E5 PASS (103d7b4) | pushed feat/books-phase1
- 2026-10-06 | E1c | PASS (24a77ca) | UI-3-fix1 | PASS (8e9b4f9)
- 2026-10-06 | E1d | PASS (71cde5b) | confirm blocks null vatCode; never invents SR
- 2026-10-06 | C1-3 | PASS | review queue chrome + purchases bulk; Assign=route; Revert=soft-delete draft
- 2026-10-06 | C1b | PASS | sales Uploads/tabs parity; manual record reason + invoice no gate
- 2026-10-06 | C2-1 | PASS | /books/banking coverage gaps + Not set up upload gate
- 2026-10-06 | C1b-2 | PASS | optional apply 2320 advance on sales approve; unit + gates
- 2026-10-06 | C2-2 | PASS | intended account + IBAN mismatch flag; sample CSV; statement logs
- 2026-10-06 | C3-1 | PASS | books_bank_transactions materialize + categorize UI; no post
- 2026-10-06 | C3-2 | PASS | match open item + dual-control post; Posted tab
- 2026-10-06 | C3-3 | PASS | transfer pair → one CV; linked_txn_id; dual control
- 2026-10-06 | P2A-1 | PASS | books_bank_txn_allocations; 1:N+fee+N:1; drawer; VAT on advances TBD
- 2026-10-06 | P2A-2 | PASS | match score engine + rejected_matches; unit 174 pass / 1 skip; e2e 4/4
- 2026-10-06 | P2A-3 | PASS | books_bank_rules; apply suggestions; preview; create-from-txn
- 2026-10-06 | P2A-4 | PASS | db/41 payout_group; card 2150 / gateway 1310; e2e Unmatched→RV link; unit 178p/1s e2e 5/5
- 2026-10-06 | P2A-5 | PASS | ready≠eligible without balance_ok; period picker label; unit+e2e green
- 2026-10-06 | P2A-6 | PASS | bulk journal preview+post; /books/rules; auto-link transfers; Phase 2 A close
- 2026-10-06 | P3-1 | PASS | db/55 expenses draft + EXP voucher + /books/expenses UI; unit 2/2
- 2026-10-06 | P3-2 | PASS | submit/approve/reject/resubmit; dual-control EXP journal; VAT-in-cost without TRN
- 2026-10-06 | P3-3 | PASS | bank/card paid-from match; link before approve or later; unique bank_txn; unit 7/7
- 2026-10-07 | Phase 3 | CLOSED | pushed P3-1..3 to origin/feat/books-phase1; ready for Phase 4
- 2026-10-07 | P4-1 | PASS | Ledger Journals list: Split(n), Expense filter, reversed grey, e2e chrome
- 2026-10-07 | P4-2 | PASS | SideDrawer line Dr/Cr cards + parent; audit actor/timeline; linked entry nos
- 2026-10-06 | RPT-1 | PASS (cloud: unit 209/202p/7s, e2e reports+journals 3/3 local) | ReportTable; TB+Ledger+Day Book+Ageing; drill to source; XLSX/CSV/print; owner: old booksAccountLedger double-counts pre-period lines
- 2026-10-06 | RPT-1d | PASS (cloud: unit 210/203p/7s, e2e reports+journals 3/3 local) | fixed old booksAccountLedger double count; ageing credits from receipt/payment journals (direct + bank-line); due = issue + terms; tb-vat-note restored
- 2026-10-06 | UI-NOTION | PASS (cloud: unit 210/203p/7s; e2e local 6 pass, 3 env-only fails identical on baseline) | Notion-style tables + side peek on every Books table; drawer restyle; no sheet blur
- 2026-10-07 | P4-3 | PASS | Create Entry templates; accrual auto-reverse; prepayment 1410 warning; payroll; Expense voucher option
- 2026-10-06 | HOME-1 | PASS (cloud: unit 222/215p/7s) | dashboard: money row (AR/AP/cash), linked doc counts, unassigned uploads -> inbox?unassigned=1, Reports shortcuts replace stray Ledger/TB buttons
- 2026-10-07 | P4-4 | PASS | auto-reverse run_at = 1st next month; recurring Entry n of N; schedule UI e2e; blocked legend
- 2026-10-07 | P4-5 | PASS | reverse reason+date required; drawer Reverse; dual-control; e2e
- 2026-10-07 | Phase 4 | CLOSED | P4-1..P4-5 on feat/books-phase1
- 2026-10-07 | P5-1 | PASS | db/57 close waivers/events; /books/close; lock gate; unit 237p e2e 7/7
- 2026-10-07 | P5-2 | PASS | db/58 fixed assets + depr runs; /books/fixed-assets; close Depreciation gate; unit 240p/1s e2e 7/7
- 2026-10-07 | P5-3 | PASS | db/59 FX rates + reval JV (auto-reverse); Settings FX + Close Revalue FX; gate wired
- 2026-10-07 | P5-4 | PASS | db/60 year-end closes; Close year; Golden v5; Phase 5 closed; pushed
2026-10-06 UI-NOTION-2: one table style + click-row-to-open (sales/purchases review drawer, inbox, statements, transactions); peek skips editable rows; drawer widths fixed
2026-10-06 UI-NAV-1: grouped menu with accounting names (Journals, Bank accounts/transactions, Customers & suppliers); dashboard flow strip; dead options removed
2026-10-07 FIX-P34: expense approve idempotent + dual control (creator/editor), expense validation, expense VAT in VAT201, accrual auto-reverse dated 1st of next month in that period; journal sheet/drawer state fixes
2026-10-07 FIX-P5: close/year-end (two-step dual-control YE, no double close, contra lines, quarterly VAT gate, waiver expiry, earlier months locked, reopen check), no back-dating into locked months, FX reval (AED-only accounts refused, reversed=done, as-of AR/AP, rate on/before end, stale gate), depreciation (atomic, deleted drafts, disposal month, catch-up), settlements post in their date's period
2026-10-07 FIX-P6-1: statements engine - BS equity from real P&L balances (draft/reversed/unclosed years), cash flow ties by construction (all BS accounts bucketed, disposals, FX on cash), no account dropped without statement line, per-column integrity + real TB check, columns clamped, dates validated; plain-English error messages
2026-10-07 FIX-WF-3: walkthrough fixes - receipts/payments two-step dual control (no body preparer, no double post, no orphan journal, suppliers + partial items), expenses paid-from mapping + TRN VAT warning, journals save-draft vs post + editor can't post, fixed assets postable account + cost booking, sales/purchases notes + outstanding, validation 400/409s, overlapping periods, admin-only company settings, users list, KPI due dates, day book Dr=Cr + party column, close drafts gate + readable details
