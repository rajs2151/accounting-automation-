# arnibooks — Addendum C: Upload → Review → Post workflow (bills, invoices, bank statements)

UX references: AI Accountant (Accounts Payable / Banking) and CrossVal (Onboarding / Reconciliation). Copy the
workflow, not the branding or copy. Indian concepts mapped to UAE: GSTIN → TRN; GST treatment → VAT treatment;
CGST+SGST → single VAT 5%; source/destination of supply → place of supply (emirate); "Sync to Tally" → not needed
(approve = post to our journal). Drop HSN/SAC, godown and multi-branch GST registration for now.

Timing:
- **C1 + C2** extend Phase 1 (run after the current Phase 1 fixes are shipped).
- **C3** replaces/extends the Phase 2 screen spec (run with Phase 2).
- **C4** lightweight dashboard checklist (with Phase 2; full close checklist stays in Phase 5).

---

## C1. Bills (AP) and Sales invoices (AR) — upload queue (Phase 1 extension)

```markdown
# C1: Purchases and Sales — bulk upload, processing queue, review queue

Same pattern for Purchases (bills) and Sales (invoices). Tabs on each list page:
**All | Needs Review (count) | Uploads (count)**.

## Header
- KPI tiles from open items (posted journals only): Total outstanding · Overdue · Due in next 7 days ·
  Unmatched to bank (Phase 2; show "—" until then). Currency AED, exact value on hover.
- Buttons: **Upload Bills / Upload Invoices** (primary) · ⋮ (Record manually — needs attachment or reason;
  download XLSX import template; import XLSX register). arnibooks records documents only; it never issues invoices.

## Upload modal
- Multi-file drag & drop: PDF / PNG / JPG / JPEG / HEIC, plus the XLSX register template. Per-file progress bar,
  size limit shown, minimise to a corner tray while uploading so the user can keep working.
- Each file → `extract_document` job (Addendum A pipeline). Classification may re-route: a sales invoice uploaded
  under Purchases is moved to Sales with a notice (never booked as a bill).

## Uploads tab (processing status)
- Columns: File name · size · uploaded by/at · detected type · company match · status
  (Queued / Extracting / Needs review / Ready / Failed / Duplicate) · actions (open, retry, download, delete-if-unposted).
- Failed: show the reason (unreadable, password-protected, unsupported) + Retry button; auto-retry once.
- Duplicate: link to the existing document (file hash or type+number+party+amount).

## Needs Review tab → review screen
- Queue navigation "Bill 3 of 11" with ‹ ›, **Approve & Next**, Save draft, Reject/Delete (unposted only, audited).
- Left: document viewer (zoom, fit, page thumbnails, highlighted bbox for the focused field). Draggable splitter.
- Right form:
  - Header: party (picker grouped by type, with "+ Create supplier/customer" prefilled from extraction: name, TRN,
    address, emirate, zone), document no., document date, due date (from terms), currency + rate, place of supply
    (emirate), VAT treatment.
  - **Party mismatch banner** when extracted TRN/name/address differs from the party master → side-by-side diff,
    "update party" or "keep master" (audited).
  - Two modes: **Item mode** (description, qty, rate, discount, VAT code, account, line kind revenue/disbursement/
    expense/asset/deposit, tags) and **Accounting mode** (account lines only). Extra lines: charges, discount,
    round-off.
  - Totals panel: net, VAT, gross vs the document's printed totals — any difference is red and blocks approve.
  - Field confidence: amber < threshold, red = failed validation. Hover shows the validation message.
  - "Payments made / Balance due" printed on the document → store as info only; do NOT create a receipt/payment
    (settlement comes from RV/PY or the bank in Phase 2).
- Journal preview (Dr/Cr lines with VAT codes) before Approve. Approve requires the approver role (dual control).
- Journal date = document date. No separate "voucher date" field. If the period is locked → blocked with the reason.

## All tab
- DataGrid: Doc no. · file chip · party · date · due date (overdue red) · status (Draft / Posted / Partially paid x% /
  Paid / Void) · outstanding · total · tags. Drawer = document + journal + allocations + audit.

## Validation rules to prove with tests (cases from our real samples, anonymised into fixtures)
- Bill with mixed lines: gov-fee line no VAT (→ disbursement 1220) + service lines 5%.
- Gov-authority bill (no VAT at all) → all lines disbursement recoverable.
- Supplier TRN present but no VAT on a service line → flagged "check VAT", not silently accepted.
- Foreign-currency bill with no supplier TRN → VAT recoverable = 0; refundable security deposit line → asset account
  (deposit), not expense.
- Sales invoice in USD with "– Arnifi Fee" (5%) and "– Government Fee" (no VAT) lines → revenue + 1220 split.
- Exempt residential lease invoice → exempt VAT code, no output VAT.
- Document classified as a sales invoice uploaded as a bill → re-routed, not posted as a purchase.
- VAT > 5% of taxable (e.g. tax larger than subtotal) → red, approve blocked.
```

---

## C1b. Sales invoices — record-only (Phase 1 extension)

```markdown
# C1b: Record sales invoice (upload-only, no issuance) — review form, open-item allocation

## Form (same component as the bill review form, sales direction)
- Header: customer (picker + "+ Create customer" drawer: name, legal name, TRN, VAT treatment, country, emirate,
  zone, address, contact, payment terms, bank details — no "opening balance" field here; openings come only from
  the opening-balance import), invoice no., invoice date, due date (terms), currency + rate, place of supply
  (emirate), reference / PO no., narration.
- Item mode / Accounting mode. Default revenue account per customer/item, overridable per line.
- **VAT is computed from the line VAT code — never typed as a separate tax line.** No free "Taxes" section.
  RCM is a VAT code, not a separate selector. Totals panel: net, VAT by rate, gross, AED equivalent if foreign.
- Extra lines (charges/discount/round-off) carry their own VAT code.

## Allocation on approval (replaces a manual "bill-wise allocation" popup)
- Approve creates the open item automatically (one per invoice; due date from terms).
- If the customer has unallocated advances (2320) or unapplied credit notes, show "Apply advance / credit" with
  amounts — user ticks which to apply → posts Dr 2320 / Cr AR (or CN allocation). Never allocate by default.
- Allocation total cannot exceed invoice gross; remaining stays open.

## DECISION: arnibooks does NOT issue invoices (record-only)
- Sales invoices are issued by the client's own system (Zoho, Tally, etc.). arnibooks only records them.
- Primary path: **Upload Invoices** (PDF/image) or **Import XLSX register** → extraction → Needs Review → approve.
- Secondary: "Record manually" (for a missed field or a client-provided list) — requires an attached source
  document (PDF/image/XLSX row) OR a mandatory reason; audited. No "Create Invoice" as the main button.
- No invoice number series, no tax-invoice PDF generation, no logo/signature/bank-details customisation, no
  emailing to customers. Remove any "issue/send/print invoice" UI.
- Same rule for credit notes we record: original CN number from the client's system, linked to the original invoice.

## Numbering
- Doc no. = the invoice number printed on the client's document (required, duplicate-checked per customer).
- SV- voucher no. is internal, assigned on post. The list must never show a blank number for an approved document.

## Extraction checks specific to recorded sales invoices (flag, don't fix the client's document)
- Missing FTA tax-invoice content on the source → warning on review (no supplier TRN, no customer TRN where the
  customer is VAT-registered, no "Tax Invoice" title, VAT not shown in AED for foreign-currency invoices, no
  per-line VAT). Approve still allowed with a note; listed later in the VAT Working "Observation" sheet.
- Invoice numbers out of sequence / gaps in the client's series → info flag for the VAT review.

## List (All / Needs Review / Uploads per C1)
- Columns: Invoice no. · customer · invoice date · created at (show only in drawer/audit, not as a main column) ·
  due · status · outstanding · total. Outstanding can never exceed total — assert in a test.
- Rows with missing customer cannot be approved (reference showed approved invoices with blank customer).

## Tests
- VAT auto from codes; manual tax amount impossible. Outstanding ≤ total. Approve without customer blocked.
- Apply advance at approval → 2320 reduced, AR open item reduced. Manual record without attachment or reason
  blocked. No issue/print/send invoice routes exist.
```

---

## C2. Bank accounts & statement uploads (Phase 1 extension)

```markdown
# C2: Bank accounts page + statement upload (extraction only; matching is Phase 2)

## Bank accounts page (Banking)
- One row per bank / card / gateway / cash account (COA postable accounts flagged is_bank/is_card/is_gateway):
  account name + code · type (Bank / Credit card / Gateway / Cash) · bank · IBAN / last 4 · currency ·
  statement coverage (e.g. "01/04/2026 – 31/08/2026", gaps in red) · last statement closing balance ·
  ledger balance · difference · unreviewed lines count · Upload · ⋮.
- Accounts missing bank/type/IBAN show "Not set up" in red and block upload until completed.

## Upload statement
- From the page header or the row action. Account preselected from the row; when uploading from the header,
  **detect account from IBAN/card number**; if the file's IBAN ≠ selected account → block with message (AI Accountant
  lets a statement land on the wrong ledger — we must not).
- Formats: PDF (text or scanned via docTR), CSV, XLSX/XLS (saved column-mapping profile per bank), Stripe CSV preset.
  Provide "Download sample sheet" for CSV/XLSX.
- Multi-account statements (several IBANs in one PDF) → split per account automatically.
- Statements list per account: file · period from–to · rows · opening/closing · status (Queued / Extracting /
  Needs review / Extracted / Failed) · balance check ✓/✗ · download · delete (only if no line has been used).
- Failed → reason + Retry (manual) + one auto-retry. Show "Statement logs" (who uploaded, when, extractor version,
  errors).

## Overlap & gaps
- Overlapping periods with an already-imported statement → line-level dedupe (date + amount + reference + running
  balance); show "n duplicate rows skipped". Never import the same row twice.
- Coverage gaps between statements flagged on the account row and in the close checklist (Phase 5).

## Gates
- Opening + Σcredits − Σdebits = closing per account and running balance continuity, else the statement stays
  "Needs review" (statement review screen from Addendum A §6) and its lines are not available to Phase 2.
```

---

## C3. Transactions review (Phase 2 — merge into the Phase 2 prompt)

```markdown
# C3: Per-account transactions — Needs Review → Ready → Posted

Entry: Banking page row → "<Account> – Transactions" (account switcher dropdown in the title), or the global
Transactions screen (all accounts, existing Phase 2 spec) with an Account filter.

## Tabs
**Needs Review (count) | Ready to post (count) | Posted | Excluded** — plus "Unmatched" filter chip.
Grouped by month (collapsible). Toggle "Show suggested only".

## Columns
Checkbox · Date (read-only — comes from the statement; correcting it = edit the statement row, audited) ·
Description (bank narration + counterparty guess bold + Add note) · **Type** (Customer receipt / Supplier payment /
Transfer between own accounts / Card repayment / Gateway payout / Bank charge / Owner capital or drawings /
Loan / Tax payment (VAT/CT) / Other income / Other expense) · **Match** (open invoice/bill/expense picker with ✓/!)
OR **Account** (two-level picker: group → account, from COA) · VAT code (only enabled when a tax invoice is attached) ·
Amount (In +green / Out −red; never label bank-side "Debit/Credit") · Score / suggestion source · Reviewed ✓.

- Suggestion sources shown as a small chip with reason: "Rule: <name>", "Same as 12/08 txn", "Invoice SV-2026-0012
  (amount+name)". No LLM until PORTAL_SECURITY_STATUS=PASS. Don't call it "AI".
- Category status and match status are separate. A categorised line is NOT "matched" (CrossVal shows green ticks on
  categories in a "Matched" tab — don't).
- A customer receipt must settle AR when an open invoice exists — never booked straight to revenue if an invoice
  is open (prevents double revenue). Same for supplier payments vs AP.
- Inventory/asset accounts on a bank payment without a bill → warning.

## Row click → side peek panel (Notion-style, slides from right, ‹ › to move between rows, Esc to close)
- Header: amount, In/Out, account, date, status, statement source link.
- Voucher: type (RV / PY / CV / JV — auto from Type), voucher no. (auto on post), date (= bank date).
- Allocation: match candidates with score breakdown; split across several invoices/accounts; differences
  (bank fee / FX / discount) to the right accounts; running "unallocated" amount must be 0 to mark Ready.
- Journal preview, attachments (upload receipt → extraction), notes/comments, audit.
- Buttons: Mark reviewed (→ Ready) · Post (approver) · Exclude (reason) · Create rule from this.

## Bulk
- Select rows → set Type / Account / tags, Mark reviewed, Post selected (approver, preview all journals first).

## Tests
- Receipt with open invoice → settles AR (no revenue line). Transfer pair detected across two accounts → one CV.
- Bank date not editable from the grid. Posting requires unallocated = 0. Excluded lines never post.
```

---

## C4. Dashboard — monthly checklist per company (with Phase 2)

```markdown
# C4: Dashboard — "This month" checklist per company (read-only summary; full close in Phase 5)

Cards, each with status, count and a deep link:
1. Statements uploaded — per bank/card/gateway account: coverage to month end ✓ / gap ✗ ("Upload statement").
2. Documents to review — Needs Review counts for bills, invoices, statements.
3. Bank lines to review — Needs Review + Ready-not-posted counts ("Review now").
4. Unassigned inbox — files not matched to a company.
5. Period status — open/locked; VAT return due date for the company's stagger.
Top bar: issues badge (count of failed extractions + balance-check failures) linking to a list.
No budget/variance card (out of scope for now).
```
