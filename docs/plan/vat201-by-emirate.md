# VAT 201 by emirate — design note (P2B-2)

Status: data capture shipped (db/51, db/53, `src/server/books/place-of-supply.ts`). Owner decisions of
2026-10-06 applied (see "Decisions" below).

## Decisions (owner, 2026-10-06)

1. **Emirate rule = by supply type**, kept in one function, `decidePlaceOfSupply`. The owner will confirm it
   with a tax adviser; change it only there, then run the admin re-apply.
   - Sales: services → the company's own establishment emirate (`clients.establishment_emirate`, set in
     Settings); goods → the customer's (delivery) emirate.
   - Purchases: services → the supplier's emirate; goods → delivered to us → the company's emirate.
   - Foreign counterparty on the party side → `OUTSIDE_UAE`.
   - Goods vs services per line: `inventory`/`asset` lines, or revenue on a `product` account (4200) = goods;
     disbursements = no supply; everything else = services. A document mixing goods and services has no single
     emirate → gap (set an override). A document with no VAT-able lines → `not_applicable` (never a gap).
   - The draft override (reason required, audited) stays. `reapplyPlaceOfSupplyRule` (admin, audited) re-derives
     every non-override document, posted included, after a rule or company-emirate change.
2. **Approve never blocks** on a missing emirate. **VAT return generation blocks** while the gap list for the
   return period is non-empty.
3. VAT stagger and establishment emirate are admin-only Settings fields.
4. VAT 201 box mapping fixed in db/54 (ZR → 4, EX → 5, SR/RC by direction).

## Why

The VAT 201 return splits standard-rated supplies and their output VAT by emirate (Boxes 1a–1g: Abu Dhabi,
Dubai, Sharjah, Ajman, Umm Al Quwain, Ras Al Khaimah, Fujairah). We can only produce those boxes if every posted
sales document says which emirate it belongs to. TallyPrime (tested 2026-10-06) keeps the emirate on the party
master (`LEDSTATENAME`) and derives the split from it. We do the same and also keep a per-document snapshot, so a
later edit to the party does not rewrite a filed return.

## What is stored

On `books_documents` (sales invoices, purchase bills, credit notes, debit notes):

| Column | Meaning |
|---|---|
| `place_of_supply` | One of the 7 emirates, `OUTSIDE_UAE`, or NULL (unknown) |
| `place_of_supply_source` | `party` · `company` · `original` (note inherits its invoice/bill) · `override` · `missing` · `not_applicable` |
| `supply_type` | `goods` · `services` · `mixed` · `none` (derived from the lines) |
| `place_of_supply_reason` | Required when source = `override` (DB check) |

Rules (enforced in code + DB checks):
- Decided by the rule at create and refreshed at approve. Once posted, only the admin re-apply changes it (audited).
- Party `country <> 'AE'` → `OUTSIDE_UAE`.
- Credit/debit notes take their original's value, so the adjustment lands in the same emirate box as the supply it corrects.
- Override: draft only, reason required, written to `books_audit_events` (`set_place_of_supply`, before/after).
- Party emirate text is normalised (`dxb`, `RAK`, `Umm-Al-Quwain`, …). Unrecognised text → `missing`.
- Migration backfills existing documents from the party master (exact canonical names only, rest → `missing`).

Gap list: `listPlaceOfSupplyGaps` / `GET /api/books/place-of-supply/gaps?from&to` returns posted documents with
no emirate (party has none) and their VAT. Approve does **not** block on a missing emirate yet (see open questions).

## How the report will use it (later)

For a VAT period (company stagger, monthly/quarterly from `books_periods`):

1. Output, Box 1a–1g: posted journal lines on 2210 VAT Output with VAT code SR (from `vat_treatment`), joined to
   their document. Group by `books_documents.place_of_supply`. Net amount = the document's SR lines' `aed_minor`.
   VAT = 2210 credits − debits. Credit notes reduce the same emirate. Read journal lines, not document totals
   (rule 1: the journal is the only source of truth). The document only supplies the emirate.
2. `OUTSIDE_UAE` with SR should not exist (exports are ZR). Flag it as an exception, don't put it in a box.
3. Box 3 (reverse charge), Box 4 (zero-rated), Box 5 (exempt), Box 9 (input), Box 10 (RCM input): no emirate split.
   Group by VAT code only.
4. Every box total must tie to the 2210 / 1430 control-account movement for the period. Any difference is a
   report-blocking exception, as are rows from the gap list.
5. Integer fils throughout. Round only at the return's display edge (AED, 2 dp).

Draft query shape (output by emirate):

```sql
SELECT d.place_of_supply,
       SUM(l.credit_minor - l.debit_minor) AS vat_minor
FROM books_journal_lines l
JOIN books_journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
JOIN books_accounts a ON a.id = l.account_id AND a.code = '2210'
JOIN books_documents d ON d.journal_entry_id = e.id
WHERE e.client_id = $1 AND e.entry_date BETWEEN $2 AND $3
  AND l.vat_treatment = 'SR'
GROUP BY d.place_of_supply;
```

(A voided document's original entry is `reversed` and its reversal is a separate JV, so both drop out of a `posted`
+ document-join query. The report needs a reversal-aware rule if a void crosses a VAT period.)

## Open questions for the owner

1. **Which emirate rule?** FTA guidance for Box 1 generally allocates *services* to the emirate of the supplier's
   (our client's) establishment from which the service is supplied, and *goods* to where they are delivered.
   Tally's party-emirate approach suits goods. For a services firm with one establishment, all output may belong
   in the client's own emirate, whatever the customer's emirate. Should the default be (a) party emirate (current),
   (b) the company's establishment emirate (needs a new `clients` emirate field, plus branches), or (c) per line
   type (goods → party, services → company)? Code supports any of these through the `override` source, but the
   default should be decided once.
2. **Block approve when the emirate is missing?** Currently it records `missing` and lists the document as a gap.
   Blocking is stricter but would stop posting for parties set up without an emirate (most synthetic test parties today).
3. **Free-zone parties:** `books_parties.zone = 'free_zone'` has no free-zone name, so we can't derive the emirate
   via `books_free_zone_emirate`. Add a `free_zone` column to parties?
4. **Designated zones:** goods supplies between designated zones may be outside scope. The report needs a rule
   (likely via VAT code, not emirate).
5. **VAT code → box map:** `books_vat_codes.vat201_box` (db/23) maps ZR → `6` and EX → `8`. On the current VAT 201
   form, zero-rated is Box 4 and exempt is Box 5. Confirm before the report uses this column.
6. VAT on customer advances is still undecided (see TALLY-1). If advances become taxable, their emirate comes from
   the receipt's party, and receipts would need the same columns.
