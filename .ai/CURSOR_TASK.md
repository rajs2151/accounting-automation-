TASK ID: E2-fix1
PHASE: Extraction (Addendum A) step 2 of 5 - bank statements: owner decisions + review defects

OBJECTIVE:
Apply the owner's two decisions on E2 (commit 20f6674) and fix the three defects the review found. Python worker +
fixtures only.

OWNER DECISIONS (2026-10-05, Raj):
1. Ambiguous multi-IBAN activity (bank_c_multi_iban.pdf: two IBANs in the header, then one opening 500.00, one
   TRANSFER IN 250.00 CR, closing 750.00, nothing tying the activity to either account):
   -> Produce TWO statements, BOTH status needs_review. Attribute the activity block by POSITION: to the IBAN whose
      section contains it (the text after that IBAN's line and before the next IBAN's line); if no section contains
      it, to the first-listed IBAN. Add flag "account_attribution_ambiguous" to that statement. It must NEVER be
      'ready' or balance_ok-as-confirmed while that flag is set. The other IBAN gets balances null +
      "balances_not_found" (as now).
2. Ground truth source:
   -> Fill fixtures/extraction/ground_truth/bank_a.json, bank_b_bilingual.json, bank_c_multi_iban.json from the
      generator's own input constants BANK_A / BANK_B / BANK_C in fixtures/extraction/generate_synthetic.py (lines
      35-62): bank, IBAN(s), currency, period if printed, opening/closing in fils, and every line (date ISO,
      description, debit/credit, amount in fils, printed running balance if any). Keep the existing doc_type and
      route keys. Derive each value from those constants (show the mapping in the report) - never from the
      extractor's output. The reviewer will cross-check against the constants.
   This is an owner-approved ground_truth edit, limited to these three files and to ADDING keys.

DEFECTS TO FIX (from the E2 review):
a. Remove the within-statement dedupe that drops identical transactions when no running balance is present
   (two identical fees on the same day are both real). Re-upload dedupe stays as is (delete-and-reinsert).
b. Running balance: when the statement prints a balance column, READ it (do not compute it), and implement the C2
   continuity check (each line's printed balance = previous balance +/- amount; break -> needs_review with the line
   and difference). When no balance column exists, leave running balance null (do not compute and present it as
   printed).
c. Line pattern: accept lines with a printed balance column and lines without CR/DR suffixes where debit/credit
   columns are used; do not silently drop lines. Add a synthetic fixture variant with a balance column (generated
   via generate_synthetic.py, with ground_truth from its constants) to prove it.

FILES TO INSPECT:
- worker/src/daftar/parsers/ (the E2 bank statement parser), worker/src/daftar/extraction/__init__.py,
  worker/tests/ (E2 tests)
- fixtures/extraction/generate_synthetic.py, fixtures/extraction/ground_truth/bank_*.json, text/bank_*.txt
- docs/plan/arnibooks-cursor-prompts-addendum-C.md C2 (lines 131-163)

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "E2-fix1:".
- worker/ and fixtures/extraction/ only. No src/, e2e/, db/ changes.
- Integer minor units. Synthetic data only.

TESTS REQUIRED (scripts/ai/gates.ps1 pytest; also unit + typecheck must stay green):
- bank_a, bank_b_bilingual: header + every line equal the new ground_truth (plain equality).
- bank_c: two statements, both needs_review; activity statement has "account_attribution_ambiguous" and is never
  ready; other IBAN balances_not_found; values equal ground_truth.
- Two identical same-day fees without running balance -> both lines kept.
- Balance-column fixture: lines extracted with printed balances; continuity check passes; a tampered balance ->
  needs_review naming the line.
- Tampered amount still -> needs_review with the right difference. All E1 tests still pass.

ACCEPTANCE CRITERIA:
1. Owner decisions 1 and 2 implemented exactly as written; report maps every ground_truth value to the generator
   constant it came from.
2. Defects a, b, c fixed and each proven by a test.
3. pytest, unit, typecheck green. Only worker/ and fixtures/extraction/ changed.

DO NOT:
- push, force-push, reset, rebase, delete branches
- edit any ground_truth other than the three bank files (and new fixtures' own files); remove existing keys
- change src/, e2e/, db/; post statement lines to the journal; implement bank matching
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If the generator constants disagree with the generated PDF text, STOP and report the difference (owner decides).
- When done, write the report to the path given in the prompt and stop.
