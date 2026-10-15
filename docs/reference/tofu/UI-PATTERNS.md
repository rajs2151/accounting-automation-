# Tofu UI patterns -> arnibooks UI spec

Source: 25 screenshots of the Tofu demo (05 Oct 2026), compared with our docs/phase1 screens
(review-split-view, statement-review, purchases, inbox). Layout and interaction reference only:
never copy Tofu branding, mascot, copy text, or the accounting errors in README.md section 7.

## 0. The one insight

Tofu's "clean and smooth" feel is mostly **shadcn/ui + lucide icons + TanStack Table**, used with
discipline. We already have the same stack (components/ui: button, badge, checkbox, dialog,
dropdown-menu, popover, select, sheet, tabs, tooltip, sonner; lucide-react; @tanstack/react-table;
pdfjs-dist). Our screens look rougher because the pages bypass those primitives: native `<select>`,
every field drawn as an input, raw enum strings, two blue primaries per screen. Most of the gap is a
UI-polish pass, not new infrastructure.

## 1. Visual tokens (what makes it calm)

| Token | Tofu | Rule for arnibooks |
|---|---|---|
| Background | very light grey app canvas, white cards | Keep our grey-50 canvas; every working area sits in a white card |
| Borders | 1px light grey, radius ~8-12px, almost no shadow | Same. No heavy shadows; shadow only on popovers/dialogs |
| Primary button | **black**, one per view (Ready & Publish, Export, Invite Member, Add Card) | Exactly **one** primary per view, in the top-right of the panel it acts on. Brand colour TBD by Raj (hex pending) |
| Secondary | white, outlined, icon on the left (CSV Template, History, Import, Templates) | Outline + lucide icon 16px + label |
| Icon buttons | ghost, square, grouped in a toolbar (eye, crosshair, file, zoom) | Ghost icon buttons always with a Tooltip |
| Colour | used **only for meaning**: yellow = warning/stale/conflict, green = success/balanced/verified, red = error/unauthorized, blue/purple = document type, status sub-label | Same. No decorative colour |
| Type | sans (Inter-like), bold titles, grey 13px labels above values, small-caps grey eyebrows (`AP BILL`, `GENERAL LINE ITEM`) | Use eyebrow style for document type and field groups |
| Numbers | right-aligned in tables | Right-aligned, tabular-nums, AED 2dp (we store fils) |

## 2. App shell and navigation

**Tofu:** left sidebar = org switcher (top, chevron-up-down) -> big outlined **Upload** button ->
Overview -> **Entities list** (2-letter country chip + name, search box, sort icon, "+" add; hovering
a row reveals a gear (settings) and kebab) -> user card at the bottom. Top bar = collapse-sidebar
icon | home icon + current entity name (breadcrumb) | **segmented control** for the view (Summary /
Settings, Document / Extraction) | search with `Ctrl K` hint | gear | primary action.

**Ours:** module nav (Home, Inbox, Sales, ...) with the company as a native select at the bottom;
top bar has "Hi Omar", native period select, search, native EN select.

**Adopt:**
1. Company switcher moves to the **top** of the sidebar as a searchable combobox (Popover + Command
   list; 2-letter chip, e.g. emirate or legal-form code). The bottom "Company" select goes.
2. Keep our module nav (we are a ledger, we need Sales/Purchases/Ledger/Reports), under the switcher.
3. One global **Upload** button at the top of the sidebar (routes to Inbox with the current company).
4. Top bar: breadcrumb (Company > Module > Document), period as a styled Select with a status dot
   (OPEN green / LOCKED grey), search with `Ctrl K` command palette, language as an icon menu.
5. Remove dev-only text from the shell: "Expenses (Phase 3)" label -> hide unbuilt modules or mark
   "Soon" with a small badge; the "Synthetic data only . FAIL" pill -> show only to admins.
6. Firm Overview page later (C4): cards = icon + title; metric rows with icon, label, right-aligned
   number; "Needs review" list rows `Company -> 19 documents . 37 lines ->` and a full-width
   outline "View all".

## 3. Document review screen (E5) - the most important screen

**Tofu layout:** three resizable panels with drag handles:
`Extractions list | Page Preview | Fields`.

- **List panel header:** collapse icon, select-all checkbox, title + **count pill** (`Extractions 7`),
  `=` menu (Filter > / 20 per page > / Collapse).
- **List card:** coloured left border by type (blue = bill, purple = statement); eyebrow `AP BILL`;
  checkbox, chevron to expand, truncated title, meta line `Draft . tofu` (status . source), kebab;
  assignee avatar icon top-right; nested sub-card for the source file/page.
- **Stale banner** at the top of the list: yellow, clock icon, "Stale data", info icon, `Review` link.
- **Preview panel:** toolbar of ghost icons (show highlights, focus/locate, open file), zoom bar
  (fit, -, 100%, +, rotate), page pager `< 1 / 6 >`.
- **Hover field -> green labelled chip on the page** (`Due Date: May 06, 2026`, `Amount: -441.77`) and
  the preview scrolls/zooms to it.
- **Fields panel header:** `< >` prev/next, document type title with a **coloured status sub-label**
  (Draft blue, Ready purple), copy-link icon, edit, re-extract (sparkle), kebab, one black primary.
- **Fields are read-first:** label above, value as plain text; on hover the value gets a border with
  pencil + copy icons; click to edit. Two-column grid (Bill number | Bill date, Due date | Currency,
  Supplier | TRN).
- **Inline badges next to values:** `New` (supplier not in contacts), conflict and confidence badges.
- **Line items** section: `Line Items (6)` title + count, `Tax exclusive` toggle at the right, table,
  pagination `<< < 1/1 > >>  20 / page`.
- **Description** collapsible section.
- **Totals block** bottom right: Subtotal; **Tax breakdown by rate** (`SR 5% on 1,000.00 ... 50.00`);
  Tax amount; **Total with a double rule**.

**Ours today (review-split-view.png):** two columns; preview shows unlabeled blue boxes; 15 stacked
full-width inputs; "low confidence" text on Due date (good idea, keep); line items as a bare table;
buttons Retry extract / Save as profile / Confirm fields bottom-left; "Statement review" link.

**E5 acceptance additions:**
1. Three panels: document list (Needs review queue for the company) | preview | fields; panels
   resizable; list collapsible.
2. Preview: pdf.js render, zoom bar, rotate, `page n / N`; **hover a field or line -> labelled chip on
   the exact bbox, auto-scroll + zoom to it, reset on mouse-out**. Click a highlight -> focus field.
3. Fields read-first with hover edit + copy; two-column grid; groups with eyebrows (DOCUMENT, PARTY,
   AMOUNTS).
4. Confidence: green / amber / red dot per field (needs E1b); amber/red keeps the doc in Needs review.
5. Header: prev/next, type + status sub-label, kebab (Retry extraction, Save as profile, Change type,
   Revert to draft), **one** primary: `Approve & next` (approver) or `Submit for approval` (maker).
6. Totals block with VAT breakdown per code and the printed-totals check shown as a green `Balanced`
   or red `Off by 0.05` badge.
7. Keyboard: `J/K` or arrows for prev/next, `Enter` to approve when allowed.

## 4. Tables and line items

**Tofu does well:** checkbox column; `#` column; right-aligned amounts; inline Selects per cell
(Account, Tax rate, Tracking) shown as `-  v` until set; focused cell gets a ring; row kebab appears
on hover; `+` add row and `Columns` picker above the grid; pagination with page size; members table
with sortable headers (up/down icon), two-line cells (name over email, date over time), chips for
role/access, `0 of 22 row(s) selected`, Previous / Next, refresh and column icons.

**Tofu does badly (do not copy):** long account names wrap to 4 lines (`310 - Cost of / Goods /
Sold`), truncated headers (`Trackin..`, `Ext. Bala...`, `CatCatCatCat`), panels too narrow for
their titles (`Extract...`, `Source D...`, `Stale data f...`).

**Rules for our DataTable (one shared component):**
1. Account cell = code in mono + name truncated with Tooltip, single line; min width per column;
   horizontal scroll inside the card, sticky first column and sticky header.
2. Amount columns: right-aligned, tabular-nums, blank (not 0.00) when empty, Debit/Credit never
   both filled.
3. Status as **Badge**, never raw enum: `needs_review` -> "Needs review" (amber), `sales_invoice` ->
   "Sales invoice". Today Purchases shows `needs_review` / `sales_invoice` in plain text.
4. Row actions in a kebab on hover; file name not underlined-blue (use a file icon + name; the row is
   clickable).
5. Toolbar above every table: search, Filter menu, Columns, page size, and a bulk bar when rows are
   selected.
6. Empty state inside the table card (see section 8), never just a header row (Inbox today).

## 5. Bank statements (E4 list, C2)

**Tofu:** fields header shows a green **Verified** stamp; filters `All accounts` / `All currencies`;
one collapsible **group header per account**: `Bank name (502-6688...)`, `New` badge, chevron,
`. GBP`, green `Balanced` check, trash, collapse; grid Debit / Credit / Account / Tax rate /
Tracking / **Ext. balance** (running balance read from the statement); inline cell edit; hover amount
-> chip on page.

**Ours (statement-review.png):** statement as a native select; Opening/Closing inputs; the formula
`Opening + Σcr - Σdr = 1,300.00 OK` written out; dates and descriptions always as input boxes;
`RB check` column with ticks; "Phase 1 staging - bank matching consumes these in Phase 2." visible.

**Adopt:**
1. Account group header like Tofu's: bank . masked IBAN `AE07 ... 3456` . currency . period .
   `Balanced` (green) or `Off by 12.40` (red) badge . collapse.
2. Opening -> closing shown as one line `1,000.00 -> 1,300.00` with the badge; the formula goes into
   a Tooltip.
3. Rows read-first; edit on click; keep the per-row running-balance check but as a small icon column
   with a Tooltip ("Running balance matches statement").
4. Account / currency filters at the top when a statement has several accounts (E2 multi-IBAN).
5. Account/VAT columns appear only in C3 (Phase 2) and VAT only when a tax invoice is matched.
6. Remove the phase/dev sentence from the page.

## 6. Dropdowns, menus and filters

- **Select / combobox:** every select is a styled trigger with chevron-up-down; long lists open a
  popover with a **search box** at the top (`Search formats...`), optional leading icon per option.
  -> Replace every native `<select>` (period, company, role, language, statement, VAT code,
  account) with `Select` (short lists) or `Combobox` (Popover + Command, searchable) for COA, parties,
  VAT codes.
- **Account picker:** search by code or name; group by account type; show `6110 Rent` in one line.
- **Filter menu:** `=` icon -> menu `Filter > / 20 per page > / Collapse`; Filter opens a cascading
  flyout: keyword search, then categories (Status, Type, Date, Error, Labels, Contact, Number,
  Amount), each with a **count badge** of active filters; the status submenu lists every status with
  its coloured circle-check icon.
  -> Our queue filter: Status, Type, Date, Error, Party, Number, Amount, Assignee.
- **Kebab menus:** row and card actions; destructive items last, red, with confirm.
- **Segmented control** (shadcn Tabs, pill style) for view switches: Document | Extraction,
  Summary | Settings, Entity | Contacts | Page Classification. Ours: `Bills | Uploads` tabs on
  Purchases currently look disabled (low-contrast blue) -> use the same pill Tabs with clear active.

## 7. Bulk actions

**Tofu:** selecting rows shows a floating **`3 selected  x`** panel with a vertical stack:
Extract 3, Export 3, Mark done 3, Change type 3, Revert 3, Delete 3 (icon + label + count).

**Ours:** a bulk bar exists on the ledger (ledger-bulk-bar.png). Reuse it on every queue with:
Retry extraction, Change type, Assign, Review later, Revert to draft (audited), Delete (only
unposted, audited), and **Approve n** only for the approver role, server-checked.

## 8. Empty, loading and status states

- Empty: large outline icon (file with `?`), bold one-liner ("Select a page to preview"), grey
  sub-line ("No page can be viewed or selected"). Upload empty state: upload-cloud icon, "Add
  documents", primary `Upload document`, secondary "Connect cloud storage".
  -> Inbox empty: "No documents yet" + `Upload` button; Needs review empty: "All caught up".
- Status vocabulary with one colour + icon each:
  Queued (grey), Extracting (yellow spinner), Needs review (amber), Review later (amber outline),
  Ready (purple), Approved/Posted (green), Failed (red), Duplicate (grey), Void (grey strike).
- Toasts (sonner) for save/approve; inline red text only for field errors.

## 9. Settings

**Tofu:** second-level vertical nav with icons (Entity information, Privacy, Members, Integrations,
Accounting, Knowledge base, Features); active item is a **filled dark pill**. Page header = title +
grey description on the left, pill tabs on the right (Tax rates | Accounts | Currencies | Contacts |
Items | Tags | Rounding). Each tab = card with title + outline `CSV template` button, full-width
search, table with checkbox column, required headers marked `*`, booleans as check / cross icons,
`Action` kebab. Integration rows = logo, name, one-line description, status pill on the right
(`Connected` green tint, `Unauthorized` red tint) or black `Connect` button.

**Adopt** for company settings: Profile & periods | Chart of accounts | VAT codes | Currencies |
Parties | Tags | Opening balances | Members & access | Rules (later) - same layout, CSV template +
import on COA, VAT codes, parties, tags, opening balances.

**Dialogs:** title + grey subtitle; labelled fields; disabled primary until valid with a count
(`Send invites (0)`); Cancel outline; summary callout box at the top for bulk dialogs
("Export 3 selected (2 invoices, 1 statement)").

## 10. Company rules / knowledge cards (Phase 2+)

Card = checkbox, bold title, yellow `! 2 conflicts` pill, right-side icon actions (history,
duplicate, Edit, delete); body with bold key words and bullets, clamped with `View more`; footer of
**field chips grouped under small-caps eyebrows** (GENERAL INVOICE: Total amount; LINE ITEM:
Description, Unit price, Tax amount). Toolbar: search, Filter, view toggle (list / grid / compact),
`28 of 28 cards`, Templates, Import, History, `+ Add rule`; segmented scope (Company | Party |
Document type) + a document-type dropdown.
-> Our rules are deterministic and versioned; a conflict **blocks** the rule until resolved; a
correction can only *suggest* a rule card for a human to accept.

## 11. Things to leave out

Promo banner and mascot, floating chat bubble covering the table, "Hide help" button, "Early"
integration badges, export-format pickers (we are the ledger), "share data to improve AI" toggle,
gamified "My performance".

## 12. Where each item lands (proposed; Raj decides order)

| Task | UI scope |
|---|---|
| **UI-0** (new, small, first) | Shared pieces only: StatusBadge + status map, Combobox, DataTable wrapper (toolbar, empty state, pagination, sticky header), ReadFirstField, Totals block, EmptyState. Replace native selects in the top bar and sidebar; company switcher to the top; remove dev text from the shell. No business logic. |
| E4 (done/landing) | Follow-up only: status badges + empty state on /books/statements list |
| E1b | Worker: per-field confidence in extraction output |
| **E5** | Section 3 in full (three panels, hover-zoom chips, read-first fields, confidence dots, totals block, one primary, keyboard) |
| C1 polish | Purchases/Sales queues on DataTable: tabs pill style, badges, filter menu, bulk bar, Review later |
| C2 | Section 5 statement layout |
| Settings slice | Section 9 tabs with CSV import |
| Phase 2+ | Section 10 rules cards; C4 overview cards |
