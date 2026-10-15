# Extraction fixtures and real-docs eval

## Real documents (owner — ING-4 acceptance)

Never commit real client files. Place them only under gitignored folders:

```
real-docs/
  your-bill.pdf
  your-statement.xlsx
  labels/
    your-bill.json          # you write ground truth
    your-statement.json
lab-out/
  eval-*.json               # eval output (gitignored)
```

Label schema (fake examples only in git):

- Invoice/bill: [`label-template.example.json`](label-template.example.json)
- Bank/card statement: [`label-template-statement.example.json`](label-template-statement.example.json)

Amounts are **integer fils** (scale 2). Use `layout_tag` to group failures (e.g. `phone_skew`, `two_column_ar`, `xlsx_header_row_5`) — never paste real TRNs/IBANs into STATUS.

```bash
npm run extraction:eval
# or
python scripts/extraction-eval.py --real-docs
python scripts/extraction-eval.py --real-docs --baseline lab-out/eval-baseline.json
python scripts/extraction-eval.py --real-docs --compare lab-out/eval-baseline.json
```

Pass `--company-trn` / `--company-name` when classifying against your synthetic company profile.

## Synthetic fixtures (CI only)

Addendum A checklist under `pdfs/`, `scans/`, `xlsx/`, `csv/`, `ground_truth/`. Used by worker pytest — **not** the ING-4 real-docs acceptance bar.

```bash
python fixtures/extraction/generate_synthetic.py
python scripts/extraction-eval.py --fixtures
```
