TASK ID: E1c
PHASE: Extraction fix - real-layout invoice fields (worker only)

OBJECTIVE:
The worker extracts invoice no, date, issuer/customer names, both TRNs, VAT and line items from common real UAE
invoice layouts, not only the synthetic "TAX INVOICE / Bill To / Date:" layout - and never guesses a VAT code.

CONTEXT (owner hit this 05 Oct on a real tax invoice; layout described here, no real data in the repo):
- Layout: issuer block top-right (name, address, "TRN : 1xxxxxxxxxxxxxx"), customer block top-left with no
  "Bill To" label, labels stacked over values ("Invoice Date" / "28 Jan 2026", "Invoice" / "Number" / "INV-0191"),
  line table Description | Quantity | Rate | Tax | Amount AED with Tax = "Tax Exempt", totals "Subtotal",
  "Total No Tax 0%  0.00", "Invoice Total AED", "Amount Due AED", bank details + stamp at the bottom.
- Result today: supplier = the CUSTOMER's name (roles swapped), customer empty, supplier TRN empty, invoice no and
  date empty, VAT empty, one line item whose description is the file name with VAT code SR (wrong: document says
  Tax Exempt), company match = mismatch.
- Causes found in worker/src/daftar/extraction/fields.py:
  1. TRN_RE = r"\b(100\d{12})\b" only accepts TRNs starting "100". UAE TRNs are 15 digits starting with "1"
     (e.g. 1051...). The issuer TRN was missed -> company match failed.
  2. _issuer_customer() takes the line after "TAX INVOICE" as issuer and only finds a customer after "Bill To".
  3. INV_RE needs "Invoice No" on one line; DATE regexes accept only dd/mm/yyyy or yyyy-mm-dd, not "28 Jan 2026".
  4. VAT label regex does not read "Total No Tax 0%" / "Tax Exempt"; line items not parsed from this table.

FILES TO INSPECT:
- worker/src/daftar/extraction/fields.py, worker/src/daftar/extraction/pdf_words.py,
  worker/src/daftar/parsers/invoice_generic.py, worker/tests/test_extraction_e1.py, fixtures/extraction/
- where the line-item VAT code "SR" is defaulted (search worker and src/server/books for the fallback) - report it

IMPLEMENTATION REQUIREMENTS:
1. TRN: 15 digits starting with 1, allowing spaces/dashes inside ("1051 8148 7700 003"); normalise to 15 digits.
   Validate length only (no checksum invented).
2. Issuer vs customer by evidence, in this order: (a) the party whose TRN appears next to "TRN"/"Tax Registration"
   in the header block and whose name matches the "payment to be made in favour of" / bank account name / footer
   = issuer; (b) labelled customer blocks ("Bill To", "Customer", "Client", "Sold To", "To:") = customer;
   (c) otherwise the unlabelled address block on the other side of the header = customer. If evidence conflicts,
   leave both with low confidence (do not guess) and add flag party_roles_uncertain.
3. Invoice number: label and value may be on separate lines or in the word grid below/right of the label
   ("Invoice Number", "Invoice No", "Inv #", "Bill No", the Arabic label for invoice number). Use word_boxes geometry
   (nearest value right of or below the label) when the text regex fails.
4. Dates: also accept "28 Jan 2026", "28-Jan-2026", "Jan 28, 2026", "28.01.2026"; output ISO; ambiguous
   numeric d/m vs m/d -> assume dd/mm (UAE) and lower confidence when day <= 12.
5. VAT: read "Tax Exempt", "Exempt", "Zero rated", "0%", "Total No Tax", "VAT 5%", "Out of scope" per line and in
   totals. Line VAT code comes only from document evidence: SR (5% shown), ZR, EX, OOS; if no evidence -> null +
   flag vat_code_missing. Never default to SR. vat_total = 0 is a real value when the document shows 0.00.
6. Line items: parse a table with a header row containing Description and Amount (optional Qty/Rate/Tax) using
   word_boxes columns; each line gets description, qty, rate, vat_code (per 5), net fils, source bbox. Fallback
   (no table found) stays one line but its description is "Invoice total" - never the file name.
7. Every new field keeps the existing output shape: fields_json[name] = {value, confidence, source {page,bbox}|null}.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "E1c:".
- worker/ + worker tests + a new SYNTHETIC fixture only. No UI, no db/, no src/server/ changes (if the SR default
  lives in src/server, report it - a separate task fixes it).
- No real client names/TRNs/IBANs in the repo. Build the fixture with invented names ("Sample Holiday Homes LLC",
  "Example Trading Inc"), TRN 100000000000099-style values and a fake IBAN, reproducing the layout above
  (issuer top-right, unlabelled customer top-left, stacked labels, Tax Exempt line, bank block, footer bar).
- No external OCR/LLM APIs. Deterministic code only.

TESTS REQUIRED:
- pytest: new fixture -> issuer, customer, both TRNs, invoice no, date (ISO), currency, net, vat 0, gross, one line
  "4th Rental Payment"-style description with vat_code EX, each with a source on the right page.
- pytest: TRN regex accepts 15-digit TRNs not starting with 100, rejects 14/16 digits.
- pytest: "28 Jan 2026" and "28-Jan-2026" parse; missing-VAT document gives vat_code null + flag, not SR.
- All existing worker tests (E1, E2, addendum A, parsers) still pass unchanged; full npm test 0 failures.

ACCEPTANCE CRITERIA:
1. New layout fixture extracts all fields above correctly with sources (pytest proves it).
2. Roles never swapped on the fixture; conflicting evidence -> low confidence + flag, not a guess.
3. No VAT code is ever defaulted; EX read from "Tax Exempt".
4. Existing goldens/ground_truth unchanged; no test skipped/narrowed.

DO NOT:
- push, force-push, reset, rebase, delete branches
- edit golden expected values or ground_truth files; disable/skip/narrow tests
- commit any real invoice, name, TRN or IBAN; call external APIs
- change UI, API, db or posting code; run `git add -A` blindly

STOP CONDITIONS:
- If fixing roles needs a field the output schema does not have, STOP and describe it.
- When done, write the report to the path given in the prompt and stop.
