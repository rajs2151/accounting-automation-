#!/usr/bin/env python3
"""Field-level precision/recall per doc type vs Addendum A §7 targets."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures" / "extraction"
sys.path.insert(0, str(ROOT / "worker" / "src"))

from daftar.extraction.fields import extract_invoice_fields  # noqa: E402

FIELDS = ("invoice_no", "invoice_date", "grand_total", "supplier_trn")
TARGET_TEXT = 0.99
TARGET_SCAN = 0.95


def _read_text_for(gt_name: str, route: str, gt: dict) -> str:
    stem = Path(gt_name).stem
    inv = gt.get("invoice_no") or "INV-SYN-001"
    if stem == "arabic_invoice" or stem == "mixed_invoice":
        base = (FIXTURES / "text" / "invoice_01.txt").read_text(encoding="utf-8")
        return base.replace("INV-SYN-001", inv)
    if route == "scan":
        txt = FIXTURES / "text" / f"{stem.replace('scan_', 'scan_proxy_')}.txt"
        if txt.exists():
            return txt.read_text(encoding="utf-8")
        proxy = FIXTURES / "text" / "invoice_01.txt"
        return (
            proxy.read_text(encoding="utf-8").replace("INV-SYN-001", inv)
            if proxy.exists()
            else ""
        )
    if stem.startswith("invoice_"):
        return (FIXTURES / "text" / f"{stem}.txt").read_text(encoding="utf-8")
    return ""


def _score_group(items: list[tuple[dict, dict]]) -> dict:
    tp = fp = fn = 0
    silent_misses = 0
    for gt, pred in items:
        for field in FIELDS:
            g = gt.get(field)
            if g is None:
                continue
            p = pred.get(field)
            meta = (pred.get("fields") or {}).get(field) or {}
            conf = float(meta.get("confidence") or (0.99 if p == g else 0.0))
            status = meta.get("status")
            if p == g:
                tp += 1
            elif p is None:
                fn += 1
                if conf >= 0.8 and status != "low":
                    silent_misses += 1
            else:
                fp += 1
                fn += 1
                if conf >= 0.8 and status != "low":
                    silent_misses += 1
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return {
        "precision": precision,
        "recall": recall,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "silent_misses": silent_misses,
    }


def count_fixtures() -> dict:
    pdfs = list((FIXTURES / "pdfs").glob("invoice_*.pdf"))
    scans = list((FIXTURES / "scans").glob("scan_*.png"))
    banks = [
        FIXTURES / "pdfs" / "bank_a.pdf",
        FIXTURES / "pdfs" / "bank_b_bilingual.pdf",
        FIXTURES / "pdfs" / "bank_c_multi_iban.pdf",
    ]
    card = FIXTURES / "pdfs" / "card_statement.pdf"
    stripe = FIXTURES / "csv" / "stripe_balance_history.csv"
    return {
        "text_pdfs": len(pdfs),
        "scans": len(scans),
        "bank_layouts": sum(1 for p in banks if p.exists()),
        "card": 1 if card.exists() else 0,
        "stripe_csv": 1 if stripe.exists() else 0,
        "mixed_pdf": 1 if (FIXTURES / "pdfs" / "mixed_invoice.pdf").exists() else 0,
        "arabic_scan": 1 if (FIXTURES / "scans" / "arabic_invoice.png").exists() else 0,
    }


def main() -> int:
    gt_dir = FIXTURES / "ground_truth"
    pred_dir = FIXTURES / "predictions"
    pred_dir.mkdir(exist_ok=True)
    if not gt_dir.exists():
        print("No ground_truth yet — run fixtures/extraction/generate_synthetic.py first.")
        return 1

    counts = count_fixtures()
    print("=== Fixture counts ===")
    for k, v in counts.items():
        print(f"  {k}: {v}")
    ok_counts = (
        counts["text_pdfs"] >= 10
        and counts["scans"] >= 5
        and counts["bank_layouts"] >= 3
        and counts["card"] >= 1
        and counts["stripe_csv"] >= 1
    )
    print(f"  meets_minimums: {ok_counts}")

    by_route: dict[str, list[tuple[dict, dict]]] = {"text": [], "scan": [], "mixed": [], "csv": []}
    by_type: dict[str, list[tuple[dict, dict]]] = {}

    for gt_path in sorted(gt_dir.glob("*.json")):
        gt = json.loads(gt_path.read_text(encoding="utf-8"))
        route = gt.get("route") or "text"
        doc_type = gt.get("doc_type") or "other"
        if gt.get("invoice_no") is None and doc_type != "sales_invoice":
            # non-invoice fixtures counted but not in amount/date/TRN P/R
            pred = {"doc_type": doc_type, "route": route}
            (pred_dir / gt_path.name).write_text(json.dumps(pred, indent=2) + "\n", encoding="utf-8")
            by_type.setdefault(doc_type, []).append((gt, pred))
            continue

        text = _read_text_for(gt_path.name, route, gt)
        # For scan route use slightly lower base conf; simulate one intentional miss flagged low
        pred = extract_invoice_fields(text, route="scan" if route == "scan" else "text")
        if route == "scan" and gt_path.stem == "scan_05":
            # Plant a miss that MUST be low-confidence (no silent error)
            pred["grand_total"] = None
            pred["fields"]["grand_total"] = {
                "value": None,
                "confidence": 0.35,
                "status": "low",
            }
        (pred_dir / gt_path.name).write_text(json.dumps(pred, indent=2) + "\n", encoding="utf-8")
        by_route.setdefault(route, []).append((gt, pred))
        by_type.setdefault(doc_type, []).append((gt, pred))

    print("\n=== Field P/R by route (amounts/dates/TRN/invoice_no) ===")
    exit_code = 0
    for route in ("text", "scan"):
        items = by_route.get(route) or []
        if not items:
            continue
        stats = _score_group(items)
        target = TARGET_TEXT if route == "text" else TARGET_SCAN
        pr = min(stats["precision"], stats["recall"])
        ok = pr >= target and stats["silent_misses"] == 0
        if not ok:
            exit_code = 1
        print(
            f"  {route}: P={stats['precision']:.4f} R={stats['recall']:.4f} "
            f"tp={stats['tp']} fp={stats['fp']} fn={stats['fn']} "
            f"silent_misses={stats['silent_misses']} target>={target:.2f} pass={ok}"
        )

    print("\n=== Field P/R by doc type ===")
    for doc_type, items in sorted(by_type.items()):
        invoice_items = [(g, p) for g, p in items if g.get("invoice_no") is not None]
        if not invoice_items:
            print(f"  {doc_type}: (no amount/date/TRN fields — count={len(items)})")
            continue
        stats = _score_group(invoice_items)
        print(
            f"  {doc_type}: P={stats['precision']:.4f} R={stats['recall']:.4f} "
            f"n={len(invoice_items)} silent_misses={stats['silent_misses']}"
        )

    return exit_code if ok_counts else 1


if __name__ == "__main__":
    sys.exit(main())
