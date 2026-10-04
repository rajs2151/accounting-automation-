"""Deterministic field extraction for synthetic fixtures (eval + unit tests)."""

from __future__ import annotations

import re
from typing import Any

TRN_RE = re.compile(r"\b(100\d{12})\b")
INV_RE = re.compile(r"(?:Invoice\s*No[:\s]+)([A-Z0-9\-]+)", re.I)
DATE_RE = re.compile(
    r"(?:Date[:\s]+)?(\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2})",
    re.I,
)
TOTAL_RE = re.compile(r"(?:Total|Grand\s*Total)\s+([\d,]+\.\d{2})", re.I)


def parse_amount_fils(raw: str) -> int:
    cleaned = raw.replace(",", "").strip()
    neg = cleaned.startswith("(") and cleaned.endswith(")")
    cleaned = cleaned.strip("()")
    whole, _, frac = cleaned.partition(".")
    fils = int(whole or "0") * 100 + int((frac + "00")[:2])
    return -fils if neg else fils


def extract_invoice_fields(text: str, *, route: str = "text") -> dict[str, Any]:
    """Return prediction JSON with per-field confidence; OCR misses flagged low."""
    base_conf = 0.99 if route == "text" else 0.96
    out: dict[str, Any] = {"route": route, "fields": {}}

    inv = INV_RE.search(text or "")
    if inv:
        out["invoice_no"] = inv.group(1)
        out["fields"]["invoice_no"] = {"value": inv.group(1), "confidence": base_conf}
    else:
        out["fields"]["invoice_no"] = {"value": None, "confidence": 0.2, "status": "low"}

    trn = TRN_RE.search(text or "")
    if trn:
        out["supplier_trn"] = trn.group(1)
        out["fields"]["supplier_trn"] = {"value": trn.group(1), "confidence": base_conf}
    else:
        out["fields"]["supplier_trn"] = {"value": None, "confidence": 0.2, "status": "low"}

    date_m = DATE_RE.search(text or "")
    if date_m:
        raw = date_m.group(1)
        if "/" in raw:
            d, m, y = raw.split("/")
            iso = f"{y}-{int(m):02d}-{int(d):02d}"
        else:
            iso = raw
        out["invoice_date"] = iso
        out["fields"]["invoice_date"] = {"value": iso, "confidence": base_conf}
    else:
        out["fields"]["invoice_date"] = {"value": None, "confidence": 0.2, "status": "low"}

    tot = TOTAL_RE.search(text or "")
    if tot:
        fils = parse_amount_fils(tot.group(1))
        out["grand_total"] = fils
        out["fields"]["grand_total"] = {"value": fils, "confidence": base_conf}
    else:
        out["fields"]["grand_total"] = {"value": None, "confidence": 0.2, "status": "low"}

    return out
