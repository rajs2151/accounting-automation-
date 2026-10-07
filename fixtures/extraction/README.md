# Extraction fixtures (synthetic only)

Addendum A §7:

- ≥10 text PDFs (varied invoice/bill layouts) → `pdfs/invoice_01.pdf` … `invoice_10.pdf`
- ≥5 scanned/photographed images → `scans/scan_01.png` … `scan_05.png` (+ `arabic_invoice.png`, skewed phone `phone_skew_01.jpg`)
- 3 bank statement layouts (multi-IBAN, bilingual) → `pdfs/bank_*.pdf`
- XLSX bank statement → `xlsx/bank_statement_a.xlsx`
- 1 card statement → `pdfs/card_statement.pdf`
- Stripe `balance_history` CSV → `csv/stripe_balance_history.csv`
- Mixed text+scan PDF → `pdfs/mixed_invoice.pdf`
- Ground-truth JSON per file under `ground_truth/`

Generate / refresh:

```bash
python fixtures/extraction/generate_synthetic.py
python scripts/extraction-eval.py
```

Committed outputs only; no real client docs.
