# OCR benchmarks (throwaway)

Synthetic-only by default. **Do not** point these scripts at real client folders unless the owner has approved anonymised use. Cloud calls require `--allow-cloud`.

## Quick start

```bash
# Local dry-run against synthetic fixture schema (no models required)
python scripts/benchmarks/run_ocr_bench.py --dry-run

# Local Tesseract only (requires tesseract + eng/ara data)
python scripts/benchmarks/run_ocr_bench.py --engines tesseract --dataset fixtures/ocr-bench

# Cloud disabled unless both flags set
python scripts/benchmarks/run_ocr_bench.py --engines textract --allow-cloud
```

Artifacts write to `scripts/benchmarks/artifacts/` (gitignored patterns recommended).
