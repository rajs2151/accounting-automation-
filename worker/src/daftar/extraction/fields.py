"""Deterministic invoice/bill field extraction with page + bbox sources."""

from __future__ import annotations

import re
from typing import Any

from daftar.extraction.pdf_words import words_on_page

TRN_RE = re.compile(r"\b(100\d{12})\b")
INV_RE = re.compile(
    r"(?:Invoice\s*No\.?|Inv\.?\s*No\.?|Document\s*No\.?|Bill\s*No\.?)[:\s]+([A-Z0-9\-]+)",
    re.I,
)
DATE_LABEL_RE = re.compile(
    r"(?:^|\n)\s*Date[:\s]+(\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2})",
    re.I,
)
DATE_ANY_RE = re.compile(r"\b(\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2})\b")
CURRENCY_RE = re.compile(r"\b(AED|USD|EUR|GBP|SAR)\b", re.I)

NET_LABEL_RE = re.compile(
    r"(?im)^(?:Subtotal|Sub\s*Total|Net(?:\s+Amount)?|Taxable(?:\s+Amount)?)\s+([\d,]+\.\d{2})\s*$"
)
VAT_LABEL_RE = re.compile(
    r"(?im)^(?:VAT(?:\s*\d+\s*%?)?|Tax(?:\s+Amount)?)\s+([\d,]+\.\d{2})\s*$"
)
GROSS_LABEL_RE = re.compile(
    r"(?im)^(?:Grand\s*Total|Amount\s*Due|Total(?:\s+Due)?)\s+([\d,]+\.\d{2})\s*$"
)
# Line-item amount used as net when no Subtotal label (synthetic layouts).
LINE_AMOUNT_RE = re.compile(
    r"(?im)^(?!.*\b(?:VAT|Tax|Total|Grand|Subtotal|Net|Taxable)\b)[A-Za-z][^\n]*?\s+([\d,]+\.\d{2})\s*$"
)

# Legacy aliases used by extraction-eval.py
TOTAL_RE = re.compile(r"(?:Total|Grand\s*Total)\s+([\d,]+\.\d{2})", re.I)
DATE_RE = re.compile(
    r"(?:Date[:\s]+)?(\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2})",
    re.I,
)


def parse_amount_fils(raw: str) -> int:
    cleaned = raw.replace(",", "").strip()
    neg = cleaned.startswith("(") and cleaned.endswith(")")
    cleaned = cleaned.strip("()")
    whole, _, frac = cleaned.partition(".")
    fils = int(whole or "0") * 100 + int((frac + "00")[:2])
    return -fils if neg else fils


def _iso_date(raw: str) -> str:
    raw = raw.strip()
    if "/" in raw:
        d, m, y = raw.split("/")
        return f"{y}-{int(m):02d}-{int(d):02d}"
    return raw


def _field(
    value: Any,
    *,
    confidence: float,
    status: str,
    source: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "value": value,
        "confidence": confidence,
        "status": status,
        "source": source,
    }


def _missing(base_conf: float = 0.0) -> dict[str, Any]:
    return _field(None, confidence=base_conf, status="missing", source=None)


def _ok(value: Any, confidence: float, source: dict[str, Any] | None) -> dict[str, Any]:
    return _field(value, confidence=confidence, status="ok", source=source)


def _has_valid_source(source: dict[str, Any] | None) -> bool:
    """True only when source has a page and a 4-number bbox."""
    if not source:
        return False
    page = source.get("page")
    bbox = source.get("bbox")
    if page is None or not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return False
    return all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in bbox)


def _located(value: Any, confidence: float, source: dict[str, Any] | None) -> dict[str, Any]:
    """Status ok only with a real source; otherwise low + null source, lower confidence."""
    if _has_valid_source(source):
        return _ok(value, confidence, source)
    return _field(
        value,
        confidence=min(float(confidence), 0.7),
        status="low",
        source=None,
    )


def _union_bbox(words: list[dict[str, Any]]) -> list[float]:
    return [
        min(float(w["x0"]) for w in words),
        min(float(w["y0"]) for w in words),
        max(float(w["x1"]) for w in words),
        max(float(w["y1"]) for w in words),
    ]


def find_source(
    word_boxes: list[dict[str, Any]],
    needle: str,
    *,
    page: int | None = None,
    prefer_pages: list[int] | None = None,
) -> dict[str, Any] | None:
    """Locate needle text among word boxes; return {page, bbox} or None."""
    if not needle:
        return None
    needle_norm = re.sub(r"\s+", " ", str(needle)).strip()
    tokens = needle_norm.split()
    if not tokens:
        return None

    if page is not None:
        pages = [page]
    elif prefer_pages:
        pages = list(prefer_pages)
    else:
        pages = sorted({int(w["page"]) for w in word_boxes if "text" in w and "x0" in w})

    for p in pages:
        words = words_on_page(word_boxes, p)
        if len(tokens) == 1:
            target = tokens[0]
            for w in words:
                t = str(w.get("text") or "")
                if t == target or t.replace(",", "") == target.replace(",", ""):
                    return {
                        "page": p,
                        "bbox": [float(w["x0"]), float(w["y0"]), float(w["x1"]), float(w["y1"])],
                    }
            continue
        n = len(tokens)
        for i in range(len(words) - n + 1):
            window = words[i : i + n]
            y_mid = [(float(w["y0"]) + float(w["y1"])) / 2 for w in window]
            if max(y_mid) - min(y_mid) > 8:
                continue
            joined = " ".join(str(w.get("text") or "") for w in window)
            if joined == needle_norm or joined.casefold() == needle_norm.casefold():
                return {"page": p, "bbox": _union_bbox(window)}
            if joined.replace(",", "") == needle_norm.replace(",", ""):
                return {"page": p, "bbox": _union_bbox(window)}
    return None


def _amount_source(
    boxes: list[dict[str, Any]],
    raw: str,
    page: int,
) -> dict[str, Any] | None:
    """Locate amount on page; return valid {page,bbox} or None (never bbox-null with ok)."""
    src = find_source(boxes, raw, page=page) if boxes else None
    if _has_valid_source(src):
        return src
    return None


def _search_pages_last_first(
    page_texts: list[str], pattern: re.Pattern[str]
) -> tuple[str, int] | None:
    """Search page texts from last → first; return (amount_raw, 1-based page)."""
    for idx in range(len(page_texts) - 1, -1, -1):
        m = pattern.search(page_texts[idx] or "")
        if m:
            return m.group(1), idx + 1
    return None


def _issuer_customer(
    page_texts: list[str],
) -> tuple[str | None, str | None, str | None, str | None]:
    """Return issuer_name, issuer_trn, customer_name, customer_trn."""
    text = "\n".join(page_texts)
    issuer_name = None
    customer_name = None
    issuer_trn = None
    customer_trn = None

    m_iss = re.search(r"(?i)TAX\s+INVOICE\s*\n([^\n]+)", text)
    if m_iss:
        candidate = m_iss.group(1).strip()
        if not re.match(r"(?i)^(trn|bill\s*to|invoice|date|فاتورة)\b", candidate):
            issuer_name = candidate

    m_cust = re.search(r"(?i)Bill\s*To[:\s]+([^\n]+)", text)
    if m_cust:
        customer_name = m_cust.group(1).strip()

    bill_pos = re.search(r"(?i)Bill\s*To", text)
    bill_at = bill_pos.start() if bill_pos else len(text)
    before = text[:bill_at]
    after = text[bill_at:]
    m_iss_trn = TRN_RE.search(before)
    m_cust_trn = TRN_RE.search(after)
    if m_iss_trn:
        issuer_trn = m_iss_trn.group(1)
    if m_cust_trn:
        customer_trn = m_cust_trn.group(1)
    if not issuer_trn:
        all_trns = TRN_RE.findall(text)
        if all_trns:
            issuer_trn = all_trns[0]
            if len(all_trns) > 1 and not customer_trn:
                customer_trn = all_trns[1]

    return issuer_name, issuer_trn, customer_name, customer_trn


def extract_invoice_fields(
    text: str,
    *,
    route: str = "text",
    page_texts: list[str] | None = None,
    word_boxes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return prediction JSON with per-field confidence and optional source locations.

    Totals (net/VAT/gross) are taken from the last page that has a totals block.
    Missing VAT stays null with status \"missing\" — never assume 5%.
    """
    base_conf = 0.99 if route == "text" else 0.96
    pages = page_texts if page_texts is not None else [text or ""]
    boxes = word_boxes or []
    blob = "\n".join(pages) if pages else (text or "")
    prefer_first = list(range(1, len(pages) + 1))
    prefer_last = list(range(len(pages), 0, -1))

    out: dict[str, Any] = {"route": route, "fields": {}}

    inv = INV_RE.search(blob)
    if inv:
        val = inv.group(1)
        src = find_source(boxes, val, prefer_pages=prefer_first) if boxes else None
        out["invoice_no"] = val
        out["document_number"] = val
        out["fields"]["invoice_no"] = _located(val, base_conf, src)
        out["fields"]["document_number"] = _located(val, base_conf, src)
    else:
        out["fields"]["invoice_no"] = _missing(0.2)
        out["fields"]["document_number"] = _missing(0.2)

    date_m = DATE_LABEL_RE.search(blob) or DATE_ANY_RE.search(blob)
    if date_m:
        raw = date_m.group(1)
        iso = _iso_date(raw)
        src = find_source(boxes, raw, prefer_pages=prefer_first) if boxes else None
        out["invoice_date"] = iso
        out["document_date"] = iso
        out["fields"]["invoice_date"] = _located(iso, base_conf, src)
        out["fields"]["document_date"] = _located(iso, base_conf, src)
    else:
        out["fields"]["invoice_date"] = _missing(0.2)
        out["fields"]["document_date"] = _missing(0.2)

    issuer_name, issuer_trn, customer_name, customer_trn = _issuer_customer(pages)

    if issuer_name:
        src = find_source(boxes, issuer_name, prefer_pages=prefer_first) if boxes else None
        out["issuer_name"] = issuer_name
        out["fields"]["issuer_name"] = _located(issuer_name, base_conf, src)
    else:
        out["fields"]["issuer_name"] = _missing()

    if issuer_trn:
        src = find_source(boxes, issuer_trn, prefer_pages=prefer_first) if boxes else None
        out["supplier_trn"] = issuer_trn
        out["issuer_trn"] = issuer_trn
        out["fields"]["supplier_trn"] = _located(issuer_trn, base_conf, src)
        out["fields"]["issuer_trn"] = _located(issuer_trn, base_conf, src)
    else:
        out["fields"]["supplier_trn"] = _missing(0.2)
        out["fields"]["issuer_trn"] = _missing(0.2)

    if customer_name:
        src = find_source(boxes, customer_name, prefer_pages=prefer_first) if boxes else None
        out["customer_name"] = customer_name
        out["fields"]["customer_name"] = _located(customer_name, base_conf, src)
    else:
        out["fields"]["customer_name"] = _missing()

    if customer_trn:
        src = find_source(boxes, customer_trn, prefer_pages=prefer_first) if boxes else None
        out["customer_trn"] = customer_trn
        out["fields"]["customer_trn"] = _located(customer_trn, base_conf, src)
    else:
        out["fields"]["customer_trn"] = _missing()

    cur = CURRENCY_RE.search(blob)
    if cur:
        val = cur.group(1).upper()
        src = find_source(boxes, cur.group(1), prefer_pages=prefer_last) if boxes else None
        out["currency"] = val
        out["fields"]["currency"] = _located(val, base_conf, src)
    else:
        # No printed currency code — do not invent AED; review UI may default later.
        out["fields"]["currency"] = _missing()

    # Page-aware totals: last page first. Never invent VAT.
    net_hit = _search_pages_last_first(pages, NET_LABEL_RE)
    if not net_hit:
        # Synthetic layout: service line amount before VAT/Total counts as net.
        for idx in range(len(pages) - 1, -1, -1):
            page = pages[idx] or ""
            m_line = LINE_AMOUNT_RE.search(page)
            if not m_line:
                continue
            rest = "\n".join(pages[idx:])
            if VAT_LABEL_RE.search(rest) or GROSS_LABEL_RE.search(rest) or TOTAL_RE.search(rest):
                net_hit = (m_line.group(1), idx + 1)
                break

    vat_hit = _search_pages_last_first(pages, VAT_LABEL_RE)
    gross_hit = _search_pages_last_first(pages, GROSS_LABEL_RE)
    if not gross_hit:
        gross_hit = _search_pages_last_first(pages, TOTAL_RE)

    if net_hit:
        raw, page = net_hit
        fils = parse_amount_fils(raw)
        out["net"] = fils
        out["fields"]["net"] = _located(fils, base_conf, _amount_source(boxes, raw, page))
    else:
        out["fields"]["net"] = _missing()

    if vat_hit:
        raw, page = vat_hit
        fils = parse_amount_fils(raw)
        out["vat"] = fils
        out["fields"]["vat"] = _located(fils, base_conf, _amount_source(boxes, raw, page))
    else:
        out["fields"]["vat"] = _missing()

    if gross_hit:
        raw, page = gross_hit
        fils = parse_amount_fils(raw)
        out["grand_total"] = fils
        out["gross"] = fils
        src = _amount_source(boxes, raw, page)
        out["fields"]["grand_total"] = _located(fils, base_conf, src)
        out["fields"]["gross"] = _located(fils, base_conf, src)
    else:
        out["fields"]["grand_total"] = _missing(0.2)
        out["fields"]["gross"] = _missing(0.2)

    return out
