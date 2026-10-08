# arnibooks - Project status (maintained by the AI loop + reviewer)

## Now
- Phase: **ING (ingestion review)** on feat/books-phase1 — after Phase 7
- Current task: **ING-4** extraction accuracy (real-docs eval) — in progress
- 2026-10-08: **ING-4 Gate 0** worker pytest with S3 stand-in: **120 passed**, 0 failed (6 warnings)
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
  - NOT DONE: surface AR/AP control drift on Health (ING-1 follow-up still queued)
  - NOT DONE: Textract / external OCR-LLM (blocked until security PASS)
- 2026-10-07: **ING-1 money correctness** on feat/books-phase1 (no new db migration)
  - Gates: eslint src+e2e 0 errors / 7 warnings (pre-existing); next build exit 0; local e2e 10/10; unit 341p/0f/1s; typecheck 0
  - DONE: exchange rate required on bank, receipt/payment and inbox postings; no 1.0 fallback for foreign currency (AED uses identity scale); bank recon still compares account-currency/original amounts (correct once journals store original + AED)
  - DONE: reverse-charge open item equals the amount credited to 2110 (net, not gross)
  - DONE: control accounts blocked on bank post without open-item settlement (staging to 1210/2110 allowed for match; categorise-only / bare category JV throws `control_account_requires_open_item`; manual journals throw `control_account_forbidden`)
  - DONE: control vs open-items check on the issues badge (and month checklist); NOT on the Health page itself
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
1. **ING-4b–4d** invoice/statement pipeline + checks (after 4a)
2. ING-1 follow-up: surface AR/AP control drift on Health
3. Phase 2 Stream B deferred: B5/B6 goldens, Stripe charge paths
4. Polish backlog (Review later, paid/unpaid types, non-UAE VAT→cost, …)

## Known issues / open decisions
- Test (VERIFY-S1-FIX1 review): approver least-privilege test does not first prove Layla can SELECT the rows before showing DELETE/UPDATE change 0 rows - add a row-count check in a later task.
- Company A month-1 golden is PROVISIONAL - owner to supply hand-computed values (Claude offered to prepare).
- VAT on customer advances: policy TBD (not implemented).
- Expense receipt threshold: NULL until owner sets (do not invent default).
- Real reference file docs/reference/outputs/*.xlsx is gitignored; only anonymised copies may be committed.
- Pending inputs: brand hex + font; B/C opening balances.
- UI polish backlog (not in UI-1..4): Review later status, paid/unpaid types, non-UAE VAT->cost, knowledge cards,
  stale extraction, snippet split, settings CSV, firm overview, email-in, E1b worker confidence.
- E1c report: SR default is in src/server/books/inbox.ts confirmInboxAsDocument and review UI normalizeLines
  (not the worker) — tracked as E1d.

## Log
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
