#!/usr/bin/env python3
"""Extraction accuracy eval — primary target: owner real-docs + labels (gitignored).

Usage (from repo root, with worker on PYTHONPATH):

  # Real files (recommended):
  python scripts/extraction-eval.py --real-docs
  python scripts/extraction-eval.py --real-docs --baseline lab-out/eval-baseline.json
  python scripts/extraction-eval.py --real-docs --compare lab-out/eval-baseline.json

  # Optional: existing synthetic fixtures (CI / smoke only — not ING-4 acceptance):
  python scripts/extraction-eval.py --fixtures

Outputs under /lab-out/ are never committed. STATUS may cite rates and layout_tag names only.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker" / "src"))

from daftar.extract import extract_file  # noqa: E402
from daftar.extraction.classify import classify_document  # noqa: E402
from daftar.extraction.eval_metrics import (  # noqa: E402
    aggregate_scores,
    compare_aggregates,
    score_document,
    validate_label_schema,
)
from daftar.extraction.fields import extract_invoice_fields  # noqa: E402
from daftar.parsers.base import pick_parser  # noqa: E402
from daftar.sniff import sniff  # noqa: E402

REAL_DOCS = ROOT / "real-docs"
LAB_OUT = ROOT / "lab-out"
FIXTURES = ROOT / "fixtures" / "extraction"


def _pred_from_file(path: Path, company_trn: str = "", company_name: str = "") -> dict:
    content = path.read_bytes()
    kind, mime = sniff(content)
    t0 = time.perf_counter()
    page_timings_ms: list[dict] = []
    raw_text = ""
    word_boxes: list = []
    methods: list = []

    if kind in ("pdf", "image", "xlsx", "xls", "csv"):
        extraction = extract_file(content, kind)
        pages = list(getattr(extraction, "raw_pages", []) or [])
        raw_text = "\n".join(pages)
        methods = list(extraction.methods or [])
        # Distribute total time across pages for a coarse per-page figure
        elapsed = (time.perf_counter() - t0) * 1000
        n = max(len(methods), len(pages), 1)
        per = round(elapsed / n, 1)
        for i, method in methods or [(1, kind)]:
            page_timings_ms.append({"page": i, "method": method, "ms": per})

    parser, _score = pick_parser(path.name, mime, content)
    parsed = None
    parse_error = None
    if parser is not None:
        try:
            parsed = parser.parse(path.name, mime, content)
        except Exception as exc:  # noqa: BLE001
            parse_error = type(exc).__name__
    extras = (parsed.extras if parsed else None) or {}
    if extras.get("raw_text"):
        raw_text = str(extras["raw_text"])
    if extras.get("word_boxes"):
        word_boxes = list(extras["word_boxes"])

    classification = classify_document(
        path.name,
        raw_text or "",
        parser_type=getattr(parsed, "doc_type", None) if parsed else None,
        parser_conf=(getattr(parsed, "confidence", 0) or 0) / 100.0 if parsed else 0.0,
        company_trn=company_trn or None,
        company_name=company_name or None,
    )

    fields_out: dict = {}
    flat: dict = {
        "doc_type": classification.doc_type,
        "confidence": classification.confidence,
        "flags": list(classification.reasons),
        "page_timings_ms": page_timings_ms,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
        "parse_error": parse_error,
        "methods": methods,
    }

    doc_type_s = str(getattr(parsed, "doc_type", "") or "") if parsed else ""
    if parsed and (doc_type_s.startswith("bank") or "statement" in doc_type_s):
        # Statement-shaped extras
        accounts = extras.get("accounts") or []
        if accounts and isinstance(accounts[0], dict):
            acc = accounts[0]
            flat.update(
                {
                    "bank_name": acc.get("bank_name"),
                    "iban": acc.get("iban"),
                    "currency": acc.get("currency"),
                    "period_from": acc.get("period_from"),
                    "period_to": acc.get("period_to"),
                    "opening_minor": acc.get("opening_minor"),
                    "closing_minor": acc.get("closing_minor"),
                    "lines": acc.get("lines") or [],
                }
            )
        elif extras.get("lines") is not None:
            flat["lines"] = extras.get("lines")
    else:
        inv = extract_invoice_fields(
            raw_text or "",
            route="ocr" if any(m == "ocr" or str(m).endswith("ocr") for _, m in (methods or [])) else "text",
            word_boxes=word_boxes or None,
        )
        fields_out = inv.get("fields") or {}
        flat.update({k: inv.get(k) for k in ("invoice_no", "invoice_date", "currency", "grand_total", "doc_type") if k in inv})
        # Promote common field values
        for key in (
            "invoice_no",
            "invoice_date",
            "due_date",
            "issuer_name",
            "issuer_trn",
            "customer_name",
            "customer_trn",
            "supplier_name",
            "supplier_trn",
            "currency",
            "subtotal",
            "vat_total",
            "grand_total",
            "net",
            "vat",
            "gross",
        ):
            meta = fields_out.get(key) if isinstance(fields_out, dict) else None
            if isinstance(meta, dict) and meta.get("value") is not None:
                flat[key] = meta["value"]
        flat["lines"] = inv.get("line_items") or inv.get("lines") or []
        if inv.get("doc_type"):
            flat["doc_type"] = inv["doc_type"]

    flat["fields"] = fields_out
    return flat


def _load_real_pairs(docs_dir: Path) -> list[tuple[Path, dict]]:
    labels_dir = docs_dir / "labels"
    pairs: list[tuple[Path, dict]] = []
    if not docs_dir.is_dir():
        return pairs
    for path in sorted(docs_dir.iterdir()):
        if not path.is_file():
            continue
        if path.suffix.lower() not in {".pdf", ".png", ".jpg", ".jpeg", ".heic", ".xlsx", ".xls", ".csv"}:
            continue
        label_path = labels_dir / f"{path.stem}.json"
        if not label_path.is_file():
            print(f"  skip (no label): {path.name}")
            continue
        label = json.loads(label_path.read_text(encoding="utf-8"))
        errs = validate_label_schema(label)
        if errs:
            print(f"  skip (bad label {errs}): {path.name}")
            continue
        pairs.append((path, label))
    return pairs


def _print_aggregate(agg: dict) -> None:
    o = agg.get("overall") or {}
    print(
        f"  documents={o.get('documents')} labeled_fields={o.get('n_labeled')} "
        f"accuracy={o.get('accuracy')} found_rate={o.get('found_rate')} "
        f"false_confidence_rate={o.get('false_confidence_rate')} "
        f"false_confidence_n={o.get('n_false_confidence')}"
    )
    print("  by layout_tag:")
    for tag, row in (agg.get("by_layout_tag") or {}).items():
        print(
            f"    {tag}: docs={row.get('documents')} acc={row.get('accuracy')} "
            f"false_conf={row.get('false_confidence_rate')}"
        )
    print("  by field:")
    for field, row in (agg.get("by_field") or {}).items():
        print(
            f"    {field}: acc={row.get('accuracy')} found={row.get('found_rate')} "
            f"false_conf={row.get('false_confidence_rate')}"
        )


def run_real_docs(args: argparse.Namespace) -> int:
    docs_dir = Path(args.real_docs) if args.real_docs else REAL_DOCS
    out_dir = Path(args.out) if args.out else LAB_OUT
    out_dir.mkdir(parents=True, exist_ok=True)

    pairs = _load_real_pairs(docs_dir)
    if not pairs:
        print(f"No labeled files under {docs_dir} (need files + labels/<stem>.json).")
        print("See fixtures/extraction/label-template.example.json for schema (fake values only).")
        return 1

    print(f"=== Real-docs eval ({len(pairs)} labeled files) ===")
    company_trn = args.company_trn or ""
    company_name = args.company_name or ""
    doc_scores: list[dict] = []
    for path, label in pairs:
        # Do not print path contents — stem + layout_tag only
        tag = label.get("layout_tag") or "unspecified"
        print(f"  extracting layout_tag={tag} …")
        try:
            pred = _pred_from_file(path, company_trn=company_trn, company_name=company_name)
        except Exception as exc:  # noqa: BLE001
            print(f"    error={type(exc).__name__}")
            pred = {"doc_type": label.get("doc_type"), "fields": {}, "elapsed_ms": None, "flags": ["extract_failed"]}
        scored = score_document(label, pred)
        scored["stem"] = path.stem  # local only; strip before STATUS paste if sensitive
        doc_scores.append(scored)

    agg = aggregate_scores(doc_scores)
    print("=== Aggregate (rates only) ===")
    _print_aggregate(agg)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = out_dir / f"eval-{stamp}.json"
    payload = {
        "generated_at": stamp,
        "mode": "real-docs",
        "document_count": len(doc_scores),
        "aggregate": agg,
        # Per-doc scores include match booleans only — strip values for safe sharing
        "documents": [
            {
                "layout_tag": d.get("layout_tag"),
                "doc_type": d.get("doc_type"),
                "n_labeled": d.get("n_labeled"),
                "n_match": d.get("n_match"),
                "n_false_confidence": d.get("n_false_confidence"),
                "accuracy": d.get("accuracy"),
                "false_confidence_rate": d.get("false_confidence_rate"),
                "elapsed_ms": d.get("elapsed_ms"),
                "page_timings_ms": d.get("page_timings_ms"),
                "field_names_false_conf": [
                    f["field"] for f in (d.get("fields") or []) if f.get("false_confidence")
                ],
            }
            for d in doc_scores
        ],
    }
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path.relative_to(ROOT)} (gitignored)")

    if args.baseline:
        baseline_path = Path(args.baseline)
        baseline_path.parent.mkdir(parents=True, exist_ok=True)
        baseline_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"Saved baseline → {baseline_path}")

    if args.compare:
        prev = json.loads(Path(args.compare).read_text(encoding="utf-8"))
        rows = compare_aggregates(prev.get("aggregate") or {}, agg)
        print("=== Compare vs baseline (field rates) ===")
        for r in rows:
            print(
                f"  {r['field']}: acc {r['accuracy_before']}→{r['accuracy_after']} "
                f"false_conf {r['false_conf_before']}→{r['false_conf_after']}"
            )

    # Exit 0 always for real-docs (owner measures); non-zero only on no files
    return 0


def run_fixtures_smoke() -> int:
    """Optional smoke on committed synthetics — not the ING-4 acceptance bar."""
    gt_dir = FIXTURES / "ground_truth"
    if not gt_dir.is_dir():
        print("No fixtures/extraction/ground_truth")
        return 1
    print("=== Fixtures smoke (synthetic; not real-docs acceptance) ===")
    n = 0
    for gt_path in sorted(gt_dir.glob("*.json")):
        gt = json.loads(gt_path.read_text(encoding="utf-8"))
        if gt.get("invoice_no") is None and "bank" not in str(gt.get("doc_type", "")):
            continue
        # Text proxy for invoice only
        text_path = FIXTURES / "text" / f"{gt_path.stem}.txt"
        if not text_path.is_file():
            continue
        text = text_path.read_text(encoding="utf-8")
        pred = extract_invoice_fields(text, route="text")
        scored = score_document(gt, pred)
        n += 1
        print(f"  {gt_path.stem}: acc={scored.get('accuracy')} false_conf={scored.get('n_false_confidence')}")
    print(f"scored {n} text fixtures")
    return 0 if n else 1


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--real-docs", nargs="?", const=str(REAL_DOCS), default=None, help="Eval labeled real-docs (default path if flag alone)")
    p.add_argument("--fixtures", action="store_true", help="Smoke synthetic fixtures only")
    p.add_argument("--out", default=str(LAB_OUT), help="Output directory (default lab-out/)")
    p.add_argument("--baseline", help="Write this run as baseline JSON path")
    p.add_argument("--compare", help="Compare this run to a prior eval JSON")
    p.add_argument("--company-trn", default="")
    p.add_argument("--company-name", default="")
    args = p.parse_args()

    if args.fixtures and not args.real_docs:
        return run_fixtures_smoke()
    if args.real_docs is not None:
        return run_real_docs(args)
    # Default: prefer real-docs if present, else fixtures smoke
    if (REAL_DOCS / "labels").is_dir() and any((REAL_DOCS / "labels").glob("*.json")):
        args.real_docs = str(REAL_DOCS)
        return run_real_docs(args)
    print("No real-docs/labels found. Pass --real-docs after adding files+labels, or --fixtures for synthetic smoke.")
    print("Label schema example: fixtures/extraction/label-template.example.json")
    return 1


if __name__ == "__main__":
    sys.exit(main())
