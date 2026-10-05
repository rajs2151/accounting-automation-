TASK ID: E1
PHASE: Extraction (Addendum A) step 1 of 5 - worker: invoice/bill fields with page + bbox (Python only)

OBJECTIVE:
In the Python worker only: classify invoices/bills correctly and extract their header fields from the text layer,
page-aware, with each field's source page + bbox, and store real word boxes. No web/TypeScript changes.

CONTEXT:
- Plan: docs/plan/arnibooks-cursor-prompts-addendum.md "ADDENDUM A" (lines 23-60). Local only: PyMuPDF/pdfplumber
  for text pages, docTR for scanned pages; no external OCR/LLM.
- worker/src/daftar/extraction/__init__.py process_extract_document: stores word_boxes = [] (always empty); on the
  running app invoice_03.pdf came back detectedType null, conf 0.3, flags no_rule_match (text PDF, so the classifier
  and parser are the problem, not OCR).
- worker/src/daftar/extract.py already opens PDFs per page with PyMuPDF (fitz).
- Shelved, UNVERIFIED reference code from a timed-out attempt: branch wip/demo-1-shelved (classify.py,
  invoice_generic.py changes). You may reuse ideas; do not copy blindly - its parser hardcoded a line description.

FILES TO INSPECT:
- worker/src/daftar/extraction/__init__.py, extraction/classify.py, extract.py, parsers/invoice_generic.py,
  parsers/base.py, worker/tests/*
- fixtures/extraction/pdfs/invoice_01..10.pdf, ground_truth/*.json, generate_synthetic.py, README.md

IMPLEMENTATION REQUIREMENTS:
1. word_boxes: [{page, x0, y0, x1, y1, text, conf}] in PDF points, origin top-left, plus {page, width, height} per
   page, for text-layer pages (PyMuPDF words). (OCR pages: keep existing behaviour; E1 does not need OCR boxes.)
2. Classifier: sales_invoice vs purchase_bill vs other from document content (not filename), with reasons.
   Company perspective: if the issuer TRN/name is the company's own -> sales_invoice; if the customer/bill-to is the
   company -> purchase_bill.
3. Fields: document number, document date (ISO), issuer name + TRN, customer name + TRN, currency, net, VAT, gross.
   Each field = {value, confidence, status ok|low|missing, source: {page, bbox} | null}. Not found -> value null,
   status "missing". Never invent amounts; never assume 5% VAT.
4. Page-aware totals: take net/VAT/gross from the totals block (search last page first), not the first match in the
   concatenated text.
5. Add a synthetic 2-page invoice fixture (generate_synthetic.py + ground_truth) with the totals block on page 2.

CONSTRAINTS:
- Work on feat/books-phase1. Local commits only, message prefix "E1:".
- Python worker + fixtures ONLY. No changes under src/, e2e/, db/.
- Integer minor units. Synthetic fixtures only.

TESTS REQUIRED (pytest; run via scripts/ai/gates.ps1 pytest):
- Every invoice_01..10 + the new 2-page fixture: doc type, number, date, issuer TRN and gross match ground_truth.
- 2-page fixture: gross.source.page == 2 and its bbox contains the word(s) of the printed total.
- A fixture with no VAT line -> vat value null, status "missing" (no 5% assumption).
- word_boxes non-empty with page numbers for text PDFs.

ACCEPTANCE CRITERIA:
1. pytest gate green; all fixtures above match ground_truth.
2. Every found field has source page+bbox; missing fields are null.
3. No changes outside worker/ and fixtures/. No ground_truth edited (except the new fixture's own file).

DO NOT:
- push, force-push, reset, rebase, delete branches
- change src/, e2e/, db/; call external OCR/LLM/API
- edit existing ground_truth or golden files, disable/skip/narrow any test
- run `git add -A` blindly - stage only the files for this task

STOP CONDITIONS:
- If an existing ground_truth looks wrong versus its PDF, STOP and list it (owner decides).
- When done, write the report to the path given in the prompt and stop.
