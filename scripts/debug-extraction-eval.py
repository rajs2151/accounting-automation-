#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker" / "src"))
from daftar.extraction.fields import extract_invoice_fields

FIXTURES = ROOT / "fixtures" / "extraction"

for gt_path in sorted((FIXTURES / "ground_truth").glob("*.json")):
    gt = json.loads(gt_path.read_text(encoding="utf-8"))
    if gt.get("invoice_no") is None:
        continue
    route = gt.get("route") or "text"
    stem = gt_path.stem
    if route == "scan":
        txt = FIXTURES / "text" / f"{stem.replace('scan_', 'scan_proxy_')}.txt"
        if not txt.exists():
            text = (FIXTURES / "text" / "invoice_01.txt").read_text(encoding="utf-8")
            text = text.replace("INV-SYN-001", gt["invoice_no"])
        else:
            text = txt.read_text(encoding="utf-8")
    elif stem.startswith("invoice_"):
        text = (FIXTURES / "text" / f"{stem}.txt").read_text(encoding="utf-8")
    else:
        text = (FIXTURES / "text" / "invoice_01.txt").read_text(encoding="utf-8")
        text = text.replace("INV-SYN-001", gt.get("invoice_no", "INV-SYN-001"))
    pred = extract_invoice_fields(text, route="scan" if route == "scan" else "text")
    for field in ("invoice_no", "invoice_date", "grand_total", "supplier_trn"):
        if gt.get(field) is not None and pred.get(field) != gt.get(field):
            print(
                stem,
                field,
                "gt=",
                gt.get(field),
                "pred=",
                pred.get(field),
                "meta=",
                (pred.get("fields") or {}).get(field),
            )
