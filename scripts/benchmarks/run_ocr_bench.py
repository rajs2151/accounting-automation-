#!/usr/bin/env python3
"""OCR benchmark harness skeleton.

Synthetic / approved datasets only. Cloud engines require --allow-cloud.
Never print secrets. Does not upload client folders by default.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass
class FieldScore:
    field: str
    expected: str
    actual: str
    exact: bool


@dataclass
class PageResult:
    engine: str
    document_id: str
    latency_ms: float
    cost_usd_estimate: float | None
    fields: list[FieldScore]
    error: str | None = None


def normalize(value: str) -> str:
    return " ".join(value.strip().lower().split())


def score_fields(expected: dict, actual: dict) -> list[FieldScore]:
    scores: list[FieldScore] = []
    for key, exp in expected.items():
        act = str(actual.get(key, ""))
        scores.append(
            FieldScore(
                field=key,
                expected=str(exp),
                actual=act,
                exact=normalize(str(exp)) == normalize(act),
            )
        )
    return scores


def engine_dry_run(doc: dict) -> tuple[dict, float, float | None]:
    started = time.perf_counter()
    # Echo labels to prove harness wiring; real engines replace this.
    actual = dict(doc.get("labels", {}))
    latency_ms = (time.perf_counter() - started) * 1000
    return actual, latency_ms, 0.0


def engine_tesseract(doc: dict, root: Path) -> tuple[dict, float, float | None]:
    try:
        import pytesseract
        from PIL import Image
    except Exception as exc:  # pragma: no cover - optional dependency
        raise RuntimeError(f"tesseract dependencies missing: {exc}") from exc

    image_path = root / doc["image"]
    started = time.perf_counter()
    text = pytesseract.image_to_string(Image.open(image_path), lang="eng+ara")
    latency_ms = (time.perf_counter() - started) * 1000
    # Placeholder parse: real implementation maps text → fields.
    actual = {"raw_text_len": str(len(text))}
    return actual, latency_ms, 0.0


def engine_textract_blocked(doc: dict) -> tuple[dict, float, float | None]:
    raise RuntimeError(
        "Textract adapter not invoked: pass --allow-cloud and implement "
        "credentials via environment. Refuses to read arbitrary Downloads paths."
    )


ENGINES = {
    "dry-run": engine_dry_run,
    "tesseract": engine_tesseract,
    "textract": engine_textract_blocked,
}


def load_dataset(dataset: Path) -> list[dict]:
    manifest = dataset / "manifest.json"
    if not manifest.exists():
        return [
            {
                "id": "synthetic-demo",
                "image": "missing.png",
                "labels": {
                    "invoice_number": "INV-001",
                    "total": "105.00",
                    "currency": "AED",
                },
            }
        ]
    return json.loads(manifest.read_text(encoding="utf-8"))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=Path("fixtures/ocr-bench"))
    parser.add_argument("--engines", default="dry-run")
    parser.add_argument("--allow-cloud", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("scripts/benchmarks/artifacts/last_run.json"),
    )
    args = parser.parse_args(argv)

    engines = ["dry-run"] if args.dry_run else [e.strip() for e in args.engines.split(",")]
    docs = load_dataset(args.dataset)
    results: list[PageResult] = []

    for engine_name in engines:
        if engine_name not in ENGINES:
            print(f"unknown engine: {engine_name}", file=sys.stderr)
            return 2
        if engine_name in {"textract"} and not args.allow_cloud:
            print("refusing cloud engine without --allow-cloud", file=sys.stderr)
            return 3
        for doc in docs:
            try:
                if engine_name == "tesseract":
                    actual, latency_ms, cost = ENGINES[engine_name](doc, args.dataset)
                    fields = [
                        FieldScore("raw_text_len", "n/a", actual.get("raw_text_len", ""), False)
                    ]
                elif engine_name == "dry-run":
                    actual, latency_ms, cost = ENGINES[engine_name](doc)
                    fields = score_fields(doc.get("labels", {}), actual)
                else:
                    actual, latency_ms, cost = ENGINES[engine_name](doc)
                    fields = score_fields(doc.get("labels", {}), actual)
                results.append(
                    PageResult(
                        engine=engine_name,
                        document_id=doc["id"],
                        latency_ms=latency_ms,
                        cost_usd_estimate=cost,
                        fields=fields,
                    )
                )
            except Exception as exc:  # keep going; record failure
                results.append(
                    PageResult(
                        engine=engine_name,
                        document_id=doc.get("id", "?"),
                        latency_ms=0.0,
                        cost_usd_estimate=None,
                        fields=[],
                        error=str(exc),
                    )
                )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "policy": {
            "allow_cloud": bool(args.allow_cloud),
            "dataset": str(args.dataset),
            "note": "synthetic/approved only; no Downloads auto-scan",
        },
        "results": [asdict(r) for r in results],
    }
    args.out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {args.out} ({len(results)} results)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
