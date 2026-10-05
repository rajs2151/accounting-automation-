# Tofu (gotofu.com) - reference notes for arnibooks

Workflow/layout reference only. Never copy branding, copy text, or the errors listed below.
Tofu is an AI extraction layer that exports to other ledgers (Xero, QuickBooks, AutoCount...). arnibooks IS the
ledger, so anything about "export to another system" is out of scope.

## 1. Firm level
| Tofu | arnibooks use |
|---|---|
| Overview: Usage, **Needs Review per company** (extractions + documents, click-through), My performance | Firm dashboard (C4 / Phase 7): per company - needs review, unmatched lines, period status. Skip usage/gamification |
| Searchable company ("entity") sidebar with per-company settings cog | Replace company dropdown once client count grows |
| Global Upload button, routed to the right company | Have it (Unassigned inbox + company match) |
| Members: invite by email, primary role, **per-company access**, joined date, WhatsApp | Admin screen for roles + user_client_access |
| Create entity: name, slug, country, "share data to improve AI" toggle | Company profile exists. **Never** offer data-sharing for AI training |

## 2. Per-company settings
- Integrations (Xero, QuickBooks, Jaz, NetSuite...) - **skip**, we are the ledger.
- File sources: Google Drive, SharePoint, **email-in**, **WhatsApp** - adopt email-in/WhatsApp intake **after
  PORTAL_SECURITY_STATUS=PASS**.
- Accounting tabs: Tax rates, Accounts, Currencies, Contacts, Items, **Tags (parent + selectable)**, Rounding - each
  with **CSV template import** -> adopt as per-company Settings tabs (VAT codes, COA, currencies, parties, tags) with
  CSV import for client onboarding.
- **Knowledge base**: plain-language rule cards per company (e.g. "extract withholding tax as separate line",
  "select tax rate only from the entity's list - never guess", "never adjust amounts to force totals", "translate line
  descriptions, keep supplier legal name"), tagged to fields, with **conflict warnings** and **version history**,
  per document type (AP bill, ...), templates, import -> adopt as deterministic, versioned, audited company rules
  (default account per supplier, VAT code rules, disbursement keywords) with conflict detection. Extends Addendum A §5
  source profiles + Phase 2 rules engine.

## 3. Document processing
- **Document view**: one file -> pages -> **snippets**; a multi-receipt PDF becomes several bills, each "Linked to 1
  invoice" -> adopt (split one upload into several documents linked to page regions; Addendum A classification step).
- **Extraction view**: three panels - extractions list | page preview (zoom, fit, rotate, page n/N) | fields.
  **Hover a field -> labelled highlight on the page** ("Due Date: May 06, 2026") -> adopt in E5 viewer.
- **"Stale data" banner** when source/rules changed after extraction, with Review -> adopt (flag re-extraction).
- **"New" badge** on a supplier not yet in contacts -> adopt next to party field ("New supplier - create?").
- Prev/next between documents, auto title ("RingGo - May 2026"), Draft -> **Ready & Publish**.
- Line items: Account, Type, Tax rate per line; "Tax exclusive" toggle; totals with **tax breakdown by rate** -> adopt.
- Auto-generated description of the document - later (needs LLM, after security gate).
- **Bulk actions** on selected: Extract, Export, Mark done, **Change type**, Revert, Delete -> adopt Change type,
  Revert (to draft, audited), bulk approve (approver only). Delete only unposted, audited.

## 4. Bank statements
- Multi-account statement with **All accounts / All currencies** filters; per account: bank + number, currency,
  **"Balanced" check**, "New" account badge.
- Row grid: Debit, Credit, **extracted running balance**, inline Account / Tax rate / Tracking per row, Columns
  picker, add row, pagination; hover amount -> highlight on page; "Verified" status -> matches our statement review
  (Addendum A §6) + C3. Adopt the account/currency filters and per-account balance badge.

## 5. Status model and filters
Statuses: Pending, Processing, Draft, Ready, Review later, Verified, Limit reached, Manual cleanup, Exported,
Published, Done, Deleted. Filters: status, extraction type, date, error, labels, contact, invoice number, amount;
page size; collapse.
-> Ours: Queued, Extracting, Needs review, Review later, Ready, Posted, Failed, Duplicate, Void. Add **Review later**,
error filter, amount/contact/number filters.

## 6. Export
Export selected extractions to other systems' formats (AutoCount, Xero, Bukku, BrightBooks... CSV/Excel), zipped per
document type -> **not needed** (approve = post to our journal). Our exports are the FS pack, VAT Working pack, TB/ledger
XLSX/PDF (Addendum B) and plain CSV of registers.

## 7. Tofu errors arnibooks must block
1. Grocery receipt (salad, milk, coffee) coded to **310 Cost of Goods Sold** -> account-vs-supplier sanity warning.
2. All grocery lines **"Zero-rated purchases 0%"** with no evidence - UAE groceries are 5%; never guess a rate
   (Tofu's own rule card says so).
3. Receipt **"paid cash"** booked as an **AP bill** - a paid receipt is not a payable: expense paid from petty
   cash/card, no AP open item. Distinguish receipt vs bill.
4. **Foreign VAT** (UK RingGo 20%, GBP) - never UAE input VAT; goes into cost. Add explicit "non-UAE VAT = cost" rule.
5. One bank statement split into **per-page extractions** - we keep one statement per account across pages.
6. VAT on a bank-line categorisation without a tax invoice - only allowed with a tax invoice attached.
7. Knowledge cards with unresolved **conflicts** still active - ours: conflicting rules block until resolved.

## 8. Ideas to queue (owner decides order)
1. Firm overview with Needs Review per company (C4 / Phase 7)
2. Per-company settings tabs + CSV import
3. Versioned company rules with conflict detection
4. Snippet splitting of multi-document files (Addendum A)
5. Hover-to-highlight fields (E5)
6. Stale-extraction flag
7. Paid receipt vs unpaid bill document types (C1 / Phase 3)
8. "Non-UAE VAT = cost" rule
9. Review later status, bulk Change type / Revert
10. Email-in / WhatsApp intake (after security gate)

## 9. Screen-level UI patterns
See `UI-PATTERNS.md` in this folder (from 25 demo screenshots, 05 Oct 2026): shell/navigation, the three-panel
review screen, tables and line items, statements, dropdowns/filters, bulk actions, empty states, settings,
rule cards, and where each item lands (UI-0, E5, C1 polish, C2, settings slice).

Demo call notes (05 Oct): hover a field auto-zooms the preview to its source; per-field confidence colour;
knowledge base learns from corrections and from typed "teach" instructions (ours: suggest-only, human approves,
deterministic + versioned); per-supplier line-item summary (description only, VAT/accounts from real lines);
bank-line coding only for Xero in Tofu (ours: C3, VAT only with a tax invoice).
