"""Local-only: extract one file via daftar (OCR may load models). Never commit output."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# Allow running from repo root: python scripts/lab/extract_one_inner.py
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker" / "src"))

from daftar.extract import extract_file  # noqa: E402
from daftar.extraction.classify import classify_document  # noqa: E402
from daftar.parsers.base import pick_parser  # noqa: E402
from daftar.sniff import sniff  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--file", required=True)
    p.add_argument("--company-trn", default="")
    p.add_argument("--company-name", default="")
    p.add_argument("--out", required=True)
    args = p.parse_args()

    path = Path(args.file)
    content = path.read_bytes()
    kind, mime = sniff(content)

    t0 = time.perf_counter()
    pages_meta: list[dict] = []
    extraction = None
    raw_excerpt = ""
    if kind in ("pdf", "image", "xlsx", "xls", "csv"):
        extraction = extract_file(content, kind)
        for i, method in extraction.methods or []:
            pages_meta.append(
                {
                    "page": i,
                    "method": method,
                }
            )
        pages = list(getattr(extraction, "raw_pages", []) or [])
        raw_excerpt = "\n".join(pages)[:4000]
    elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)

    parser, score = pick_parser(path.name, mime, content)
    parsed = None
    parse_ms = None
    if parser is not None:
        t1 = time.perf_counter()
        try:
            parsed = parser.parse(path.name, mime, content)
        except Exception as exc:  # noqa: BLE001
            parsed = None
            parse_error = str(exc)[:500]
        else:
            parse_error = None
        parse_ms = round((time.perf_counter() - t1) * 1000, 1)
    else:
        parse_error = "no_parser"

    text_for_classify = raw_excerpt
    if parsed is not None:
        text_for_classify = (parsed.extras or {}).get("raw_text") or raw_excerpt

    classification = classify_document(
        path.name,
        text_for_classify or "",
        parser_type=getattr(parsed, "doc_type", None) if parsed else None,
        parser_conf=(getattr(parsed, "confidence", 0) or 0) / 100.0 if parsed else 0.0,
        company_trn=args.company_trn or None,
        company_name=args.company_name or None,
    )

    fields = {}
    flags: list[str] = list(classification.reasons)
    if parsed is not None:
        fields = {
            "doc_type": parsed.doc_type,
            "party": parsed.party,
            "document_date": parsed.document_date,
            "currency": parsed.currency,
            "confidence": parsed.confidence,
            "ocr_used": parsed.ocr_used,
            "extras_keys": sorted((parsed.extras or {}).keys()),
            "invoice_no": (parsed.extras or {}).get("invoice_no")
            or (parsed.extras or {}).get("document_number"),
            "net": (parsed.extras or {}).get("net"),
            "vat": (parsed.extras or {}).get("vat"),
            "gross": (parsed.extras or {}).get("gross")
            or (parsed.extras or {}).get("grand_total"),
            "line_count": len(parsed.lines or []),
        }
        flags.extend(list((parsed.extras or {}).get("flags") or []))

    report = {
        "file": str(path),
        "bytes": len(content),
        "sniff": {"kind": kind, "mime": mime},
        "extract_ms": elapsed_ms,
        "parse_ms": parse_ms,
        "pages": pages_meta,
        "parser": {"name": getattr(parser, "name", None), "score": score},
        "parse_error": parse_error,
        "classification": {
            "doc_type": classification.doc_type,
            "confidence": classification.confidence,
            "needs_user_pick": classification.needs_user_pick,
            "reasons": classification.reasons,
        },
        "fields": fields,
        "flags": flags,
        "raw_text_excerpt": raw_excerpt[:2000],
        "timings_note": "Owner: record digital vs scanned vs image page times from extract_ms/pages.",
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "out": str(out), "extract_ms": elapsed_ms}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
