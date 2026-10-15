# arnibooks — Cursor build prompts (Phase 0 → Phase 7)

How to use:
- Paste the **MASTER CONTEXT** once at the start of a new Cursor chat (or save it as `.cursor/rules/arnibooks.mdc` so it applies to every chat).
- Then paste **one phase prompt at a time**. Don't start the next phase until the current one is merged and the golden tests pass.
- Every phase follows the same loop: Cursor writes a plan → you reply "go" → it builds and tests → shows you screens → you say "ship" → PR.

---

## MASTER CONTEXT (paste once / save as a Cursor rule)

```markdown
# Product
arnibooks: Arnifi's internal bookkeeping product for UAE SME clients, used by Arnifi accountants (not client users yet).
End goal: source documents in → journal → ledger → trial balance → P&L, Balance Sheet, Cash Flow (+ company health).
UX reference: the screenshots in `docs/reference/crossval/` (CrossVal). Replicate their layout, interactions and workflow
closely, but use Arnifi branding, our own copy/wording, and fix the accounting errors called out in each phase prompt.
Never use CrossVal's name, logo, colours or exact text in the product.

# Codebase
- Build inside the EXISTING repo (Next.js + Postgres + Python worker + MinIO, Docker Compose). Reuse its infra
  (Compose, DB, storage, worker, session/auth plumbing, numbered SQL migration convention, CI workflow).
- The earlier domain modules (ledger/recon/close/statements/ct/pipeline) are NOT the base for this build. New domain code lives in
  new modules (e.g. `src/server/books/*`, `src/app/(books)/*`, new numbered SQL files). Reuse old code only where it is clearly
  correct and you say so in the plan; never let old and new write the same tables. Old pages can stay, but are hidden from
  the new nav.
- Keep the security gate: PORTAL_SECURITY_STATUS stays FAIL → only synthetic companies in the app. Never commit real client
  documents, names, TRNs or IBANs. Real-folder testing only via a local, gitignored lab script.

# Non-negotiable accounting rules
1. The journal is the ONLY source of truth. Every screen either creates journal entries or reads posted journal lines.
   No other table changes balances.
2. Money = integer minor units (fils, scale 2) end to end (DB, API, UI formatting at the edge). No floats anywhere.
   Foreign currency lines store: original amount + currency + rate + AED amount.
3. Every entry balances (sum Dr = sum Cr), enforced by a DB constraint/trigger, not just app code.
4. Posted entries are immutable. Corrections = reversal entry (linked) + new entry. Description/note/tags may be edited (audited).
5. Locked periods reject posting, reversal and reclass into them.
6. Every create/update/post/reverse/match/approve writes an audit event (actor, timestamp UTC, before/after, source).
7. Projections/forecasts are a separate layer: they never feed TB, Balance Sheet, tax or exports of actuals.
8. VAT: 5% standard / zero-rated / exempt / out-of-scope / reverse charge. Input VAT is only recoverable with a valid tax invoice
   (supplier TRN present). Government fee / disbursement lines are pass-through: no revenue, no VAT.

# Tech conventions
- TypeScript strict. Postgres. New schema = new numbered SQL file, also applied in test setup and e2e setup.
- Background jobs in the worker/queue (parsing, OCR, scheduled entries, recurring entries).
- OCR = local Tesseract (eng+ara) only, behind an `Extractor` interface so a provider can be swapped later.
  No external OCR/LLM API calls.
- UI: one shared design system. Brand tokens in a single theme file (Arnifi brand colours — ask me for exact hex values if not
  in the repo; use placeholders meanwhile). Light mode first; tokens must make dark mode possible later.
- Tables: one shared `DataGrid` (TanStack Table + virtualisation) and one shared `SideDrawer` used by every list screen.
- Every phase ships: SQL + server logic + UI + unit tests + one end-to-end test + updated golden test.

# Golden test (grows each phase)
Synthetic companies with hand-computed expected outputs in `fixtures/books-goldens/` (JSON/XLSX, computed independently
in a spreadsheet, NOT generated from our code). The full pipeline must reproduce them exactly.
- Company A "Desert Falcon Services FZE" (services, disbursements, Stripe, AED+USD bank, credit card)
- Company B "Gulf Crest Trading LLC" (inventory, VAT both sides, partial payments)
- Company C "Palm Grove Properties LLC" (rental income, foreign customer, quarterly VAT)

# Working style
- Start every phase with a plan: tables/columns, server modules, API routes, screens, tests, open questions. Wait for "go".
- Thin slices, feat/* branches, tests green before you show me screens. Commit/PR only when I say "ship".
- Ask before making accounting-policy decisions not covered here.
- Windows host: give me PowerShell-friendly commands; prefer running tests inside Docker.
```

---

## PHASE 0 — Foundation

```markdown
# Phase 0: Foundation (companies, users, chart of accounts, periods, journal engine, audit, shared UI)

Read the MASTER CONTEXT and look at all screenshots in docs/reference/crossval/ before planning.

## 1. Tenancy, users, roles
- Firm (Arnifi) → Companies (clients) → Users. Arnifi accountants only for now.
- Roles per company: admin, accountant (prepare), approver (approve/post/reverse/lock), viewer.
- Company switcher in the top bar; every query scoped by company (Postgres RLS, reuse existing RLS approach).
- Company profile: legal name, trade licence no., TRN(s), base currency (AED), fiscal year start month, VAT registered y/n,
  VAT period (monthly/quarterly) + stagger, CT applicable y/n, emirate.
- `is_synthetic` flag honoured by the security gate.

## 2. Chart of accounts (UAE SME template)
- Seed a default UAE SME COA template that is copied into each new company (editable per company afterwards).
- Hierarchy: group → parent → account (e.g. 1000 Cash & Bank → 1001 Emirates NBD Operating).
- Fields: code, name, type (asset/liability/equity/revenue/cogs/expense/other_income/other_expense), normal balance,
  parent, is_postable (only leaf accounts), currency (for bank/card), cash_flow_class (operating/investing/financing/cash/
  non_cash), statement_line (where it lands on P&L/BS), vat_default, is_control (AR/AP/VAT — no manual posting), active.
- Must include at least: bank & cash, petty cash, card payable, gateway clearing (Stripe/Nomod/Network), AR, AP,
  Input VAT, Output VAT, VAT payable/receivable settlement, client disbursements recoverable, government fees clearing,
  employee reimbursable, prepaid expenses, accrued expenses, deferred revenue, fixed assets + accumulated depreciation,
  inventory, end-of-service gratuity provision, share capital, owner current account, retained earnings,
  opening balance equity, suspense, FX gain/loss (realised/unrealised), bank charges, depreciation, corporate tax.
- COA screen: tree grid with expand/collapse, search, add/edit/deactivate (can't delete accounts with postings).

## 3. Periods
- Monthly periods generated from fiscal year start. Status: open / locked. Lock/unlock by approver only, audited.

## 4. Journal engine (server)
- Tables: journal_entry (id, company, entry_no JE-YYYY-####, date, period, description, entry_type
  [auto|manual|closing|reversal|opening|reclass], status [draft|scheduled|posted|reversed], source_type + source_id,
  currency, created_by, posted_by, posted_at, reversed_by_entry_id, reverses_entry_id, recurring_series_id,
  series_index/series_count, note), journal_line (account, debit, credit — minor units, original currency/amount/rate,
  vat_code, tax_amount, description, tags, counterparty), entry_tag, entry_attachment, linked_document.
- DB-level guarantee: a posted entry balances and has ≥2 lines; lines only on postable accounts.
- Services: createDraft, post, schedule, reverse (creates linked opposite entry, marks original reversed), reclass,
  getAccountBalance(asOf), getAccountActivity(from,to).
- Entry numbering sequential per company per year, no gaps after posting.

## 5. Audit, tags, comments
- audit_event table (entity, entity_id, action, actor, at, before, after, meta). Helper used by every service.
- Tags: per company, coloured, manage-tags dialog; attachable to entries, transactions, expenses, report rows.
- Comments: threaded, @mentions, attached to (entity, id) or to (report, account, period) — threads must never be shared
  across rows by accident.

## 6. Shared UI (Arnifi brand)
- App shell: left icon sidebar (collapsible) with sections: Dashboard, Transactions, Expenses, Ledger, Reports,
  Company Health, Settings; top bar with greeting, company switcher, period picker, language (EN; AR-ready layout).
- Theme tokens file (Arnifi colours, typography, spacing, radius); status pills (posted/scheduled/reversed/approved/
  pending/rejected/synced), type pills (auto/manual/closing), tag chips, amount formatting (AED 1,234.56,
  negatives in brackets on reports, red/green +/- on transactions, K/M abbreviations on reports with exact value on hover).
- DataGrid component: column show/hide/resize/reorder, sort, search, filter drawer, group-by (e.g. month) with collapsible
  sections, row selection + bulk-action bar, inline edit cells, saved views (per user / shared), "read more" truncation,
  sticky header + first column, virtualised rows, CSV export, empty/loading/error states.
- SideDrawer component: header (id, title, status pills), tabs (Overview / Audit log), sections, edit-in-place fields.
- Info banners (dismissible) and a "Guide" popover pattern (as in the Ledger screenshot).

## 7. Seed + tests
- Seed companies A, B, C (synthetic) with the COA template, FY 2026 periods, users: an accountant and an approver.
- Unit tests: balance constraint, posting into locked period rejected, reversal produces exact opposite and links both,
  numbering, RLS isolation between companies, audit event written for each service call.
- Golden v0: post the opening balances for A/B/C (hand-computed TB in fixtures) and assert TB balances and equals fixture.

Deliver the plan first. Wait for "go".
```

---

## PHASE 1 — Documents, sales invoices, purchase bills, opening balances

```markdown
# Phase 1: Document ingestion + Sales invoices + Purchase bills + Opening balances

## 1. Upload & extraction
- Upload (multi-file drag & drop) from: a global "Upload" button, Transactions "Manage Transactions" menu, Expenses.
- Supported: bank statement (PDF/CSV/XLSX), credit card statement (PDF), payment gateway export (Stripe balance_history CSV;
  generic gateway CSV with column mapping), sales invoice (PDF), purchase bill (PDF/image), receipt (image/PDF),
  opening trial balance (CSV/XLSX).
- Worker pipeline: store file (MinIO, sha256 dedupe) → detect type → text layer or Tesseract (eng+ara) → parser → extracted
  fields with per-field confidence → review queue.
- Company detection from TRN / IBAN / legal name; uncertain → "Unassigned" inbox for manual routing; never auto-post.
- Duplicate detection: file hash, and (doc type, number, counterparty, amount).
- Parsers are plugins behind one interface (`detect()`, `parse()`), each with synthetic fixture files and tests. Ship:
  generic invoice/bill, 2 UAE bank layouts (multi-IBAN, multi-currency, bilingual), credit card statement,
  Stripe CSV, generic CSV with saved column mapping per source.
- Scanned/low-confidence fields are highlighted; nothing extracted by OCR posts without human confirmation.

## 2. Counterparties
- Customers & vendors per company: name, TRN, country, emirate, mainland/free zone/designated zone, default account,
  default VAT code, payment terms. Fuzzy dedupe on create ("did you mean…").

## 3. Sales invoices (AR)
- List (DataGrid) + side drawer + create/edit form ("Create Invoice" from Manage Transactions).
- Lines: item/description, qty, rate, VAT code, account, line type revenue | disbursement (gov fee pass-through),
  tags. Totals: net, VAT, gross. Currency + rate. Due date from terms.
- Approve → posts journal: Dr AR / Cr Revenue / Cr Output VAT; disbursement lines Dr AR / Cr Disbursements Clearing.
- Status: draft / approved(posted) / partially paid / paid / void (void = reversal). Credit notes as negative invoices
  linked to the original.
- Multi-month service invoices (e.g. "Aug–Jan" retainer): option to defer → Cr Deferred Revenue + scheduled monthly
  release entries (ask me to confirm the default policy).

## 4. Purchase bills (AP)
- "Upload Purchase Bill" → extraction → review form → approve → Dr Expense/Asset/Inventory/Disbursement Recoverable +
  Dr Input VAT (only if supplier TRN present, else VAT goes into cost) / Cr AP.
- Foreign suppliers of services → reverse charge flag (Output + Input VAT, net zero) — record VAT codes on the lines.
- Statuses as invoices. Debit notes linked.

## 5. Opening balances
- Import a TB (CSV/XLSX) as of the day before the first period, map lines to COA (unmapped lines block import),
  must balance; AR/AP openings require counterparty-level detail (open items) so later receipts can match.
- Manual entry screen alternative. Posted as one entry_type=opening.

## 6. Tests / golden
- Golden v1: companies A/B/C month 1 invoices + bills → expected journal lines and TB in fixtures. Assert exact match.
- e2e: upload a synthetic bill PDF → review → approve → journal visible.
```

---

## PHASE 2 — Transactions & reconciliation (CrossVal "Transactions" screen)

```markdown
# Phase 2: Transactions & Reconciliation — replicate docs/reference/crossval Transactions screens

## 1. Data
- bank_transaction (source account, date, value date, description, counterparty guess, amount signed, currency, raw line,
  statement doc id, status [unmatched|suggested|matched|excluded], category account, match links, score + score breakdown).
- match table supporting 1:1, 1:N (one payment → several invoices), N:1 (several payments → one invoice / partial
  payments), and differences (bank fee / FX difference / discount) posted to the right accounts.

## 2. Screen (replicate layout)
- Title + subtitle; top-right: Manage Tags, Filters, Rules.
- Tabs: All Transactions (count), Unmatched (count, red), Saved Views (count).
- Search (description / invoice no / amount). Banner: "We found N transactions with a missing match".
- "Manage Transactions" dropdown: Create Invoice, Add Transaction via Receipt, Upload Purchase Bill,
  Batch Sync Invoices, Batch Sync Expenses, Upload Bank/Card Statement.
- Grouped by month, collapsible sections. Unmatched rows: red left border.
- Columns: Reference ID, Date, Description (counterparty bold + narration + Add Note, Comments, source chip),
  Invoice/Expense ID (searchable picker of open invoices/bills/expenses; ✓ or ! icon), Category & Subcategory (account picker),
  Amount (+green / −red), Source, Related Docs (file chips + upload), Actions (Synced | Sync Invoice | Sync Expense),
  Score (pill coloured by threshold; hover/click shows breakdown: amount, date, name, reference, and warnings).
- Row click → SideDrawer: details, suggested matches (accept/reject), linked docs, journal preview, audit log, comments.

## 3. Matching engine
- Score = weighted amount/date/name/reference (configurable), with caps: direction mismatch never auto-matches;
  cross-period candidates (±90 days) flagged; partial-payment subset-sum within tolerance shown as a bundle.
- ≥ 0.85 auto-suggest as "ready to sync" (still shown, not posted without a user action or batch confirm);
  0.5–0.85 suggested; < 0.5 none. Rejected suggestions remembered.
- Separate statuses for categorisation and for matching (CrossVal shows a green category tick on unmatched rows — don't).

## 4. Sync = journal
- Customer receipt: Dr Bank / Cr AR (+ fee/FX difference lines). Vendor payment: Dr AP / Cr Bank.
- No-document lines: categorise directly → Dr/Cr category account vs bank, VAT only with a tax invoice attached.
- Lines that need NO invoice: transfers between own accounts (Dr Bank B / Cr Bank A — detect pairs), credit card repayment
  (Dr Card Payable / Cr Bank), gateway payouts (Dr Bank / Cr Gateway Clearing), owner drawings/capital, bank charges.
- Gateway CSV (Stripe): charge → Dr Gateway Clearing / Cr AR (or revenue); fee → Dr Merchant Fees / Cr Clearing;
  refund → reverse; payout → matched to bank deposit; clearing must net to zero per payout, otherwise exception.
  POS settlements (e.g. Network International) handled the same way — never booked as sales from the bank line.
- Batch sync: only selected rows, preview of all journals, then confirm (approver role). Synced row edited later =
  reversal + new entry.
- "Add Transaction via Receipt": upload receipt → extraction → match to an existing card/bank line or create an expense.

## 5. Rules
- Rules screen: conditions (counterparty contains / narration regex / amount range / source account / direction) →
  actions (category account, VAT code, tags, counterparty, auto-match target type). Priority order, test-on-history
  preview, "create rule from this transaction" in the drawer.

## 6. Tests / golden
- Golden v2: A/B/C month 1 statements reconciled → expected journal + TB + reconciliation (bank ledger balance =
  statement closing balance per account). Include: partial payment, one payment for two invoices, bank fee difference,
  own-account transfer, card repayment, Stripe payout group, USD account.
- e2e: Unmatched tab → pick invoice → Sync → journal appears in Ledger with link back.
```

---

## PHASE 3 — Expenses (CrossVal "Expenses" screen)

```markdown
# Phase 3: Expenses — replicate docs/reference/crossval Expenses screens

## 1. Screen
- Title "Expenses" + subtitle; search (description, vendor, expense #); Filters; "New expense".
- Status tabs with counts: All / Pending Approval / Approved / Rejected.
- Columns: Expense # (EXP-YYYY-####), Date, Submitted by, Description · Vendor, Amount, Debit account, Paid from account,
  Reporting tags (inline add/remove chips, "+ Assign Tags"), Status (with rejection reason inline), row menu.
- Rejected rows highlighted; missing-tag/missing-receipt warning icon.
- Filters drawer: date range, created by, approved by, tags (multi), amount range, paid-from account, status;
  Clear all / Apply.
- SideDrawer: header (EXP no, title, status), tabs Overview / Audit timeline; Amount (net, VAT, total, date);
  Details (description, vendor, submitted by, approved by, paid from); Line items (account, amount, VAT code + amount,
  total, tags; VAT receivable line; total); Lines & tags (dimensions e.g. department); Receipts (preview); Journal entry
  (shown once approved, link to Ledger); Approve / Reject (reason required) / Resubmit actions.

## 2. Rules & posting
- Workflow: draft → pending → approved (posted) | rejected (no journal) → resubmit (same EXP no, history kept).
- Approver ≠ submitter. Receipt mandatory above a configurable amount. VAT claimable only if receipt is a tax invoice
  with supplier TRN; otherwise VAT stays in cost.
- Account-vs-vendor sanity warning (e.g. renovation labour booked to Freight).
- Paid from: bank/card → on approval, link to the matching bank/card line (Phase 2 engine) instead of creating a second
  payment; if no line yet, post Dr Expense (+Input VAT) / Cr Bank-or-Card and later match.
  Petty cash → Cr Petty Cash. Employee out-of-pocket → Cr Employee Reimbursable; reimbursement payment clears it.
- Split lines across accounts/tags supported.

## 3. Tests / golden
- Golden v3 adds expenses for A/B/C (incl. one rejected, one employee-paid + reimbursement, one card-paid matched to the
  card statement — assert no double count).
```

---

## PHASE 4 — Ledger / Journals (CrossVal "Ledger" screen)

```markdown
# Phase 4: Ledger — replicate docs/reference/crossval Ledger screens

## 1. Screen
- Title "Ledger" (+ Beta pill), subtitle; tabs Transactions | Journals; top-right Rules, "Create Entry".
- Search (description / entry ID); Filters; Manage Tags; Guide popover (explains entry types and statuses);
  Type dropdown (Auto / Manual / Closing / Reversal / Opening / Reclass); Status dropdown (Posted / Scheduled / Reversed /
  Draft); "Select rows" toggle; entry count; dismissible info banner.
- Columns: Date, Entry ID, Description (truncated + "read more"; recurring badge "Entry 1 of 3"), Debit account(s),
  Credit account(s) (code + name, VAT lines with a "Tax" chip; >3 lines → "Split (n lines)"), Amount, Type pill,
  Status pill, Tags. Reversed rows greyed.
- SideDrawer: header (JE no, status pill, source · type); tabs Overview / Audit Log & Linked Entries.
  Overview: description (Edit), journal lines as Dr (green) / Cr (red) cards with account code+name and parent account,
  amounts; details (date, period, currency, created, last updated); linked documents (type, number, counterparty,
  status, amount — clickable); note. Audit tab: timeline (created, matched, posted, reversed, edited…) with actor, time,
  amount, and links to related entries (reversal pair, recurring series, source transaction).
- Actions: Reverse (approver, reason required, choose reversal date), Duplicate, Add tag, Add note.

## 2. Create Entry
- Templates: blank, accrual (with auto-reverse on 1st of next period), prepayment (asset now + scheduled amortisation),
  depreciation, reclassification, payroll, VAT settlement. Line grid with account picker, Dr/Cr, VAT code, tags,
  counterparty; running balance check; attachments; date + period lock check.
- Schedule: post on a future date; Recurring: frequency, start, count/end → creates a series (Entry n of N).
- Scheduled entries are excluded from all balances until posted; a daily job posts them; if the target period is locked
  → status "blocked" + notification, never silently posted.

## 3. Fix vs reference
- Journal date always comes from the source (bank line date / invoice date), timestamps from one audit source (UTC,
  shown in company timezone).
- Prepayments are assets, not "accruals" (the reference books a prepaid campaign as Dr Marketing / Cr Accrued — prevent this
  via templates + a warning).
- Closing entries only generated by the close process (Phase 5), never manually dated mid-month.

## 4. Tests
- Schedule/recurring/auto-reverse jobs, reversal immutability, filters, e2e create accrual → appears scheduled →
  job posts → TB changes.
```

---

## PHASE 5 — Month-end close & Trial Balance

```markdown
# Phase 5: Close + Trial Balance

## 1. Close checklist per company × period (screen + server gates)
- All bank/card/gateway statements uploaded for the full period (coverage check by date).
- All bank lines matched or categorised; Suspense = 0 or every item explained.
- Clearing accounts (gateway, disbursements, government fees, transfers) net to expected values.
- Scheduled/recurring entries for the period posted; accruals/prepayments reviewed.
- Depreciation run (fixed asset register: cost, date, method straight-line, life, residual → monthly entries).
- FX revaluation of foreign-currency monetary balances (rate table per company, manual entry) → unrealised gain/loss entry.
- VAT control: Output VAT − Input VAT by period reconciles to the VAT accounts.
- Missing-documents list (bank lines without invoice/bill, recurring vendors missing this month, payroll).
- Lock period (approver). Unlock requires reason, audited; posting after unlock marks downstream reports "changed".

## 2. Trial Balance
- Screen (Reports → Trial Balance tab): account code, name, opening, debit movement, credit movement, closing; grouped by
  type with subtotals; must balance (big red banner if not); period/as-of picker; drill-down into account ledger.
- Account ledger view: running balance per account, filter by date, link to entries.
- Year-end: system-generated closing entry (income/expense → retained earnings), entry_type=closing, only after the
  December checklist passes.

## 3. Tests / golden
- Golden v5: full month for A/B/C → TB equals hand-computed fixture exactly, including depreciation and FX revaluation.
```

---

## PHASE 6 — Financial Reporting (CrossVal "Profit & Loss" etc.)

```markdown
# Phase 6: Financial Reporting — replicate docs/reference/crossval reporting screens

## 1. Tabs: Profit & Loss | Balance Sheet | Cash Flow | Trial Balance (from Phase 5)

## 2. Period engine
- Column modes: Monthly / Quarterly / Yearly / custom range, fiscal-year aware; "Today" button jumps to current period.
- P&L columns = movements; Balance Sheet columns = balances at period end; Cash Flow = indirect method per column.
- Current month column split "Actuals | Projected" (highlighted); future months labelled "Projected" (when projections on).
- Partial current period labelled "MTD" and % change compared like-for-like (same days last period) — the reference
  shows −75% for a half month; don't.

## 3. P&L layout
- Revenue (groups → accounts) → COGS → Gross Profit → Operating Expenses → EBITDA → Depreciation & amortisation →
  EBIT → Finance costs / other income → EBT → Corporate tax → Net profit. Driven by COA statement_line mapping.
- Expandable tree: group → sub-group → account → source (bank/card account) rows; negatives in brackets; K/M
  abbreviations with exact value on hover; frozen first column, horizontal scroll.
- Row badges: comments icon (thread count), assignee avatar initials.

## 4. Balance Sheet & Cash Flow
- BS: Assets (current/non-current) = Liabilities (current/non-current) + Equity (incl. current year profit). Must balance.
- CF (indirect): net profit → non-cash adjustments (depreciation, unrealised FX, provisions) → working capital changes
  (AR, AP, prepaid, accrued, VAT, inventory, deferred revenue) → operating; investing (fixed assets); financing (capital,
  loans, owner account) → net change → opening cash → closing cash. Gate: closing cash = sum of bank/cash account balances.

## 5. Drill-down panel (cell click)
- Right panel: account name, period, transaction count, search, month selector, list (date, description, amount,
  link to entry), re-categorise dropdown per item → creates a reclass entry (blocked in locked periods, audited).
- Projected cells show the forecast items instead.

## 6. Comments
- Per (account, period) thread with avatars, timestamps, @mentions, notifications. Threads must be unique per row/period.

## 7. Charts & banners (top of P&L)
- Corporate tax banner: tax year, filing due date, status/estimate (9% above AED 375,000 taxable income; show "estimate").
- Revenue chart (also Expenses / Net profit selector): current value, % change, bars per period, Log scale On/Off,
  Projections On/Off (projected bars styled differently), axis in AED.

## 8. Projections (separate layer)
- Simple driver: trailing 3–6 month average or linear trend per account, editable per account (override value / growth %).
- Stored in a forecast table, never in journals; excluded from TB/BS/CT/exports of actuals; clearly styled.

## 9. Export
- Excel (one sheet per statement + TB + notes) and PDF (Arnifi-branded, company header, period, "prepared by").
- Export blocked unless TB balances, BS balances and CF ties (show which gate failed).

## 10. Tests / golden
- Golden v6: P&L, BS, CF for A/B/C (monthly + quarterly) equal hand-computed fixtures exactly.
```

---

## PHASE 7 — Company Health dashboard (CrossVal "Cash Flow and Runway" etc.)

```markdown
# Phase 7: Company Health — replicate docs/reference/crossval health screens (without partner offers)

## 1. Tabs: Dashboard | Company Scorecard | Cash Flow & Runway | Profitability & Cost Trends | Debtors & Creditors

## 2. Metrics (all from the ledger + open items; show formula on hover)
- Cash on hand (bank + cash accounts), avg net cash flow (last 3 months), cash runway (cash / avg monthly net burn;
  "n/a — cash positive" if no burn), liabilities/assets ratio; each with change vs last period.
- Receivables tracker: client, invoice, amount, due date, days overdue, avg payment time; total outstanding; overdue rows
  highlighted. Payables tracker: vendor, bill, amount, due date, status (overdue/upcoming/pending), avg payment delay.
- Payment behaviour: DSO, DPO, cash conversion cycle (DIO only if inventory), collection rate; current vs previous.
- Profitability & cost trends: gross margin %, opex by category over time, top cost movers (MoM %).

## 3. Insights (rule-based, no LLM)
- Templated insight cards triggered by thresholds, e.g. "2 clients = 61% of overdue AR", "Runway under 6 months",
  "AWS spend +27% MoM", "DSO above 45 days", each with suggested actions (chips) and links to the underlying data.
- No industry benchmarks and no partner offers in this phase.

## 4. Firm dashboard (Arnifi accountants)
- All companies × current period: close status, unmatched lines, pending expenses, suspense balance, TB status,
  VAT/CT due dates, assignee. Filters, sort, click-through.

## 5. Tests
- Metric unit tests on golden companies (hand-computed expected values).
```

---

## After Phase 7 — real-data lab (local only)

```markdown
Add `scripts/lab/run-folder.ts --input "<folder>" --company-trn <TRN> --period YYYY-MM` that runs the full pipeline
(ingest → match with auto-accept above threshold → close checks → TB → statements) against a throwaway schema, writes
journal.csv, ledger.xlsx, trial_balance.csv, pnl/bs/cf.csv and run_report.md (files used/skipped, unmatched lines,
suspense, missing documents, assumptions) to gitignored lab-output/, then drops the schema. No network calls.
```
