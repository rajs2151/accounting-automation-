"""Deterministic invoice/bill field extraction with page + bbox sources."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from daftar.extraction.pdf_words import words_on_page

# UAE TRN: 15 digits starting with 1 (not only 100…). Spaces/dashes allowed in source text.
TRN_RE = re.compile(r"\b(1\d{14})\b")
TRN_FLEX_RE = re.compile(r"(?<!\d)(1[\d][\d\s\-]{11,22}\d)(?!\d)")
INV_RE = re.compile(
    r"(?:Invoice\s*(?:No\.?|Number|#)|Inv\.?\s*(?:No\.?|#)|Document\s*No\.?|Bill\s*No\.?|"
    r"رقم\s*الفاتورة)[:\s]+([A-Z0-9][A-Z0-9\-/]*)",
    re.I,
)
# Label-only patterns used with word-box geometry (stacked "Invoice" / "Number").
INV_LABEL_TOKENS = (
    ("invoice", "number"),
    ("invoice", "no"),
    ("invoice", "no."),
    ("inv", "no"),
    ("inv", "no."),
    ("inv", "#"),
    ("bill", "no"),
    ("bill", "no."),
    ("document", "no"),
    ("document", "number"),
)

MONTH_NAME = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
)
DATE_TOKEN = (
    rf"(?:"
    rf"\d{{1,2}}/\d{{1,2}}/\d{{4}}"
    rf"|\d{{4}}-\d{{2}}-\d{{2}}"
    rf"|\d{{1,2}}\.\d{{1,2}}\.\d{{4}}"
    rf"|\d{{1,2}}\s+{MONTH_NAME}\s+\d{{4}}"
    rf"|\d{{1,2}}-{MONTH_NAME}-\d{{4}}"
    rf"|{MONTH_NAME}\s+\d{{1,2}},?\s+\d{{4}}"
    rf")"
)
DATE_LABEL_RE = re.compile(
    rf"(?:^|\n)\s*(?:Invoice\s*)?Date[:\s]+({DATE_TOKEN})",
    re.I,
)
DATE_ANY_RE = re.compile(rf"\b({DATE_TOKEN})\b", re.I)
CURRENCY_RE = re.compile(r"\b(AED|USD|EUR|GBP|SAR)\b", re.I)

NET_LABEL_RE = re.compile(
    r"(?im)^(?:Subtotal|Sub\s*Total|Net(?:\s+Amount)?|Taxable(?:\s+Amount)?)"
    r"(?:\s+AED)?\s+([\d,]+\.\d{2})\s*$"
)
# VAT total amount labels only — "Tax Exempt" is a line VAT code, not a totals amount.
VAT_LABEL_RE = re.compile(
    r"(?im)^(?:VAT(?:\s*\d+\s*%?)?|Tax(?:\s+Amount)|Total\s+No\s+Tax(?:\s*0\s*%?)?|"
    r"VAT\s*0\s*%?)"
    r"(?:\s+AED)?\s+([\d,]+\.\d{2})\s*$"
)
GROSS_LABEL_RE = re.compile(
    r"(?im)^(?:Grand\s*Total|Invoice\s*Total|Amount\s*Due|Total(?:\s+Due)?)"
    r"(?:\s+AED)?\s+([\d,]+\.\d{2})\s*$"
)
# Line-item amount used as net when no Subtotal label (synthetic layouts).
LINE_AMOUNT_RE = re.compile(
    r"(?im)^(?!.*\b(?:VAT|Tax|Total|Grand|Subtotal|Net|Taxable|Amount\s+Due)\b)"
    r"[A-Za-z][^\n]*?\s+([\d,]+\.\d{2})\s*$"
)

# Legacy aliases used by extraction-eval.py
TOTAL_RE = re.compile(r"(?:Total|Grand\s*Total|Invoice\s*Total)\s+(?:AED\s+)?([\d,]+\.\d{2})", re.I)
DATE_RE = re.compile(
    rf"(?:Date[:\s]+)?({DATE_TOKEN})",
    re.I,
)

CUSTOMER_LABEL_RE = re.compile(
    r"(?im)^(?:Bill\s*To|Sold\s*To|Customer|Client|To)\s*[:\-]\s*(.+)$"
)
PAYMENT_FAVOUR_RE = re.compile(
    r"(?is)(?:payment\s+(?:to\s+be\s+)?made\s+in\s+favou?r\s+of|"
    r"pay(?:able)?\s+(?:to|in\s+favou?r\s+of)|"
    r"account\s+name|beneficiary)\s*[:\-]?\s*([^\n,;]+)",
    re.I,
)
TRN_LABEL_NEAR_RE = re.compile(
    r"(?is)(?:TRN|Tax\s+Registration(?:\s+Number)?)\s*[:\-]?\s*"
    r"(1[\d\s\-]{13,22}\d)",
    re.I,
)

AMOUNT_TOKEN_RE = re.compile(r"^[\d,]+\.\d{2}$")
QTY_TOKEN_RE = re.compile(r"^\d+(?:\.\d+)?$")

VAT_CODE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)\bout\s+of\s+scope\b|\bOOS\b"), "OOS"),
    (re.compile(r"(?i)\btax\s+exempt\b|\bexempt\b|\bEX\b"), "EX"),
    (re.compile(r"(?i)\bzero[\s\-]?rated\b|\b0\s*%\b|\btotal\s+no\s+tax\b|\bZR\b"), "ZR"),
    (re.compile(r"(?i)\bVAT\s*5\s*%|\b5\s*%\b|\bSR\b"), "SR"),
]


def normalize_trn(raw: str | None) -> str | None:
    """Strip spaces/dashes; accept only 15 digits starting with 1 (length-only)."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if len(digits) == 15 and digits.startswith("1"):
        return digits
    return None


def find_trns(text: str) -> list[str]:
    """Return unique normalised TRNs in document order."""
    found: list[str] = []
    seen: set[str] = set()
    for m in TRN_FLEX_RE.finditer(text or ""):
        trn = normalize_trn(m.group(1))
        if trn and trn not in seen:
            seen.add(trn)
            found.append(trn)
    return found


def parse_amount_fils(raw: str) -> int:
    cleaned = raw.replace(",", "").strip()
    neg = cleaned.startswith("(") and cleaned.endswith(")")
    cleaned = cleaned.strip("()")
    whole, _, frac = cleaned.partition(".")
    fils = int(whole or "0") * 100 + int((frac + "00")[:2])
    return -fils if neg else fils


def _month_num(token: str) -> int:
    key = token[:3].lower()
    months = {
        "jan": 1,
        "feb": 2,
        "mar": 3,
        "apr": 4,
        "may": 5,
        "jun": 6,
        "jul": 7,
        "aug": 8,
        "sep": 9,
        "oct": 10,
        "nov": 11,
        "dec": 12,
    }
    return months[key]


def parse_invoice_date(raw: str) -> tuple[str | None, float, bool]:
    """Parse invoice date → (ISO yyyy-mm-dd, confidence_scale, ambiguous_dd_mm).

    Numeric d/m vs m/d assumes dd/mm (UAE). When day <= 12, mark ambiguous and
    return a lower confidence scale (caller multiplies base_conf).
    """
    raw = (raw or "").strip()
    if not raw:
        return None, 0.0, False

    # ISO
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if m:
        return raw, 1.0, False

    # 28 Jan 2026 / 28-Jan-2026
    m = re.fullmatch(
        rf"(\d{{1,2}})[\s\-]+({MONTH_NAME})[\s\-]+(\d{{4}})",
        raw,
        re.I,
    )
    if m:
        d, mon, y = int(m.group(1)), _month_num(m.group(2)), int(m.group(3))
        try:
            return datetime(y, mon, d).date().isoformat(), 1.0, False
        except ValueError:
            return None, 0.0, False

    # Jan 28, 2026
    m = re.fullmatch(rf"({MONTH_NAME})\s+(\d{{1,2}}),?\s+(\d{{4}})", raw, re.I)
    if m:
        mon, d, y = _month_num(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return datetime(y, mon, d).date().isoformat(), 1.0, False
        except ValueError:
            return None, 0.0, False

    # 28.01.2026 or 28/01/2026 — assume dd/mm (UAE)
    m = re.fullmatch(r"(\d{1,2})[./](\d{1,2})[./](\d{4})", raw)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        ambiguous = d <= 12
        try:
            iso = datetime(y, mo, d).date().isoformat()
        except ValueError:
            return None, 0.0, False
        return iso, (0.75 if ambiguous else 1.0), ambiguous

    return None, 0.0, False


def _iso_date(raw: str) -> str:
    iso, _, _ = parse_invoice_date(raw)
    return iso or raw.strip()


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
                # TRN may be split / spaced in the PDF
                if normalize_trn(t) == normalize_trn(target) and normalize_trn(target):
                    return {
                        "page": p,
                        "bbox": [float(w["x0"]), float(w["y0"]), float(w["x1"]), float(w["y1"])],
                    }
            # Multi-word TRN fragments glued
            if normalize_trn(target):
                for i in range(len(words)):
                    chunk: list[dict[str, Any]] = []
                    digits = ""
                    for w in words[i : i + 6]:
                        chunk.append(w)
                        digits += re.sub(r"\D", "", str(w.get("text") or ""))
                        if len(digits) >= 15:
                            break
                    if normalize_trn(digits) == normalize_trn(target):
                        return {"page": p, "bbox": _union_bbox(chunk)}
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


def _norm_name(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).casefold()


def _names_match(a: str | None, b: str | None) -> bool:
    na, nb = _norm_name(a), _norm_name(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if na in nb or nb in na:
        return True
    # Token overlap (LLC / FZE ignored when short)
    skip = {"llc", "fze", "ltd", "inc", "co", "company", "the", "and"}
    ta = {t for t in re.split(r"\W+", na) if len(t) >= 3 and t not in skip}
    tb = {t for t in re.split(r"\W+", nb) if len(t) >= 3 and t not in skip}
    if not ta or not tb:
        return False
    return len(ta & tb) / max(len(ta), len(tb)) >= 0.5


def _line_name_candidates(text: str) -> list[str]:
    """Heuristic company-name lines (skip labels / amounts)."""
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or len(line) < 3:
            continue
        if re.match(
            r"(?i)^(tax\s+invoice|trn|bill\s*to|sold\s*to|customer|client|invoice|"
            r"date|description|quantity|qty|rate|tax|amount|subtotal|total|vat|"
            r"payment|iban|bank|account|فاتورة)\b",
            line,
        ):
            continue
        if AMOUNT_TOKEN_RE.search(line) and not re.search(r"[A-Za-z]{3,}", line):
            continue
        if normalize_trn(line):
            continue
        if re.search(r"[A-Za-z]{3,}", line) and not re.match(r"^\d", line):
            # Strip trailing amount if present
            cleaned = re.sub(r"\s+[\d,]+\.\d{2}\s*$", "", line).strip()
            if cleaned and cleaned not in out:
                out.append(cleaned)
    return out


def _header_name_near_trn(
    text: str, trn: str, *, before_pos: int | None = None
) -> str | None:
    """Name on the line(s) above a TRN mention in the header region."""
    blob = text or ""
    # Prefer labelled TRN occurrence
    for m in TRN_LABEL_NEAR_RE.finditer(blob):
        if normalize_trn(m.group(1)) != trn:
            continue
        if before_pos is not None and m.start() > before_pos:
            continue
        prefix = blob[: m.start()]
        lines = [ln.strip() for ln in prefix.splitlines() if ln.strip()]
        for cand in reversed(lines[-4:]):
            if re.match(r"(?i)^(trn|tax\s+registration|tax\s+invoice|فاتورة)\b", cand):
                continue
            if normalize_trn(cand):
                continue
            if re.search(r"[A-Za-z]{3,}", cand):
                return re.sub(r"\s+[\d,]+\.\d{2}\s*$", "", cand).strip()
    # Fallback: line before bare TRN
    for m in TRN_FLEX_RE.finditer(blob):
        if normalize_trn(m.group(1)) != trn:
            continue
        if before_pos is not None and m.start() > before_pos:
            continue
        prefix = blob[: m.start()]
        lines = [ln.strip() for ln in prefix.splitlines() if ln.strip()]
        for cand in reversed(lines[-3:]):
            if re.match(r"(?i)^(trn|tax|invoice|bill|date|فاتورة)\b", cand):
                continue
            if normalize_trn(cand):
                continue
            if re.search(r"[A-Za-z]{3,}", cand):
                return re.sub(r"\s+[\d,]+\.\d{2}\s*$", "", cand).strip()
    return None


def _payment_favour_name(text: str) -> str | None:
    m = PAYMENT_FAVOUR_RE.search(text or "")
    if not m:
        return None
    name = m.group(1).strip().strip(".")
    name = re.sub(r"\s+", " ", name)
    if len(name) < 3:
        return None
    return name


def _customer_from_labels(text: str) -> str | None:
    m = CUSTOMER_LABEL_RE.search(text or "")
    if not m:
        return None
    name = m.group(1).strip()
    name = re.sub(r"\s+TRN.*$", "", name, flags=re.I).strip()
    return name or None


def _header_blocks_from_words(
    word_boxes: list[dict[str, Any]], page: int = 1
) -> list[dict[str, Any]]:
    """Split page-1 header words into left/right clusters with names + TRNs."""
    words = words_on_page(word_boxes, page)
    if not words:
        return []
    page_meta = next(
        (
            w
            for w in word_boxes
            if w.get("page") == page and "width" in w and "text" not in w
        ),
        None,
    )
    page_w = float(page_meta["width"]) if page_meta else 595.0
    page_h = float(page_meta["height"]) if page_meta else 842.0
    header_y = page_h * 0.42
    header = [w for w in words if float(w["y0"]) < header_y]
    if not header:
        return []

    mid_x = page_w * 0.48
    left = [w for w in header if (float(w["x0"]) + float(w["x1"])) / 2 < mid_x]
    right = [w for w in header if (float(w["x0"]) + float(w["x1"])) / 2 >= mid_x]

    def cluster(side_words: list[dict[str, Any]], side: str) -> dict[str, Any] | None:
        if not side_words:
            return None
        texts = [str(w.get("text") or "") for w in sorted(side_words, key=lambda w: (w["y0"], w["x0"]))]
        blob = " ".join(texts)
        trns = find_trns(blob)
        # Rebuild line-ish names: group by y
        rows: dict[int, list[dict[str, Any]]] = {}
        for w in side_words:
            key = int(round(float(w["y0"]) / 6) * 6)
            rows.setdefault(key, []).append(w)
        names: list[str] = []
        for y in sorted(rows):
            row = sorted(rows[y], key=lambda w: float(w["x0"]))
            line = " ".join(str(w.get("text") or "") for w in row).strip()
            if not line:
                continue
            if re.match(
                r"(?i)^(tax\s+invoice|trn|invoice|date|bill|sold|customer|client|to)\b",
                line,
            ):
                continue
            if normalize_trn(line) or find_trns(line):
                continue
            if AMOUNT_TOKEN_RE.fullmatch(line.replace(" ", "")):
                continue
            if re.search(r"[A-Za-z]{3,}", line):
                names.append(line)
        return {
            "side": side,
            "names": names,
            "trns": trns,
            "bbox": _union_bbox(side_words),
            "page": page,
        }

    blocks = []
    for side, sw in (("left", left), ("right", right)):
        c = cluster(sw, side)
        if c and (c["names"] or c["trns"]):
            blocks.append(c)
    return blocks


def _issuer_customer(
    page_texts: list[str],
    word_boxes: list[dict[str, Any]] | None = None,
) -> tuple[str | None, str | None, str | None, str | None, list[str], float]:
    """Return issuer_name, issuer_trn, customer_name, customer_trn, flags, role_conf.

    Evidence order:
      (a) TRN labelled in header + name matching payment-favour / bank / footer → issuer
      (b) labelled Bill To / Customer / Client / Sold To / To: → customer
      (c) otherwise unlabelled other header block → customer
    Conflict → low confidence + party_roles_uncertain (no guess).
    """
    flags: list[str] = []
    text = "\n".join(page_texts)
    role_conf = 0.95
    issuer_name: str | None = None
    customer_name: str | None = None
    issuer_trn: str | None = None
    customer_trn: str | None = None

    favour = _payment_favour_name(text)
    labelled_customer = _customer_from_labels(text)

    # Header cut: before first customer label or invoice meta
    bill_pos = re.search(
        r"(?i)Bill\s*To|Sold\s*To|(?:^|\n)\s*Customer\b|(?:^|\n)\s*Client\b|"
        r"Invoice\s*(?:No|Number|Date)|Description\b",
        text,
    )
    bill_at = bill_pos.start() if bill_pos else len(text)
    header = text[:bill_at]
    after = text[bill_at:]

    # (a) Issuer from labelled TRN in header, confirmed by payment favour when present
    labelled_trns: list[tuple[str, str | None]] = []
    for m in TRN_LABEL_NEAR_RE.finditer(header):
        trn = normalize_trn(m.group(1))
        if not trn:
            continue
        name = _header_name_near_trn(header, trn)
        labelled_trns.append((trn, name))

    if not labelled_trns:
        # Still accept labelled TRNs from full text when header cut was too aggressive
        for m in TRN_LABEL_NEAR_RE.finditer(text):
            if m.start() > bill_at and labelled_customer:
                break
            trn = normalize_trn(m.group(1))
            if trn:
                labelled_trns.append((trn, _header_name_near_trn(text, trn, before_pos=bill_at)))

    if labelled_trns:
        chosen: tuple[str, str | None] | None = None
        # Prefer the labelled party whose name matches payment-favour / bank footer.
        if favour:
            for trn, name in labelled_trns:
                if name and _names_match(name, favour):
                    chosen = (trn, name)
                    role_conf = max(role_conf, 0.97)
                    break
            if chosen is None:
                # Favour known but no labelled name matches — use favour as issuer name
                # and pick a TRN that is NOT next to the other header names later.
                chosen = labelled_trns[-1] if len(labelled_trns) > 1 else labelled_trns[0]
                issuer_name_from_favour = favour
            else:
                issuer_name_from_favour = None
        else:
            chosen = labelled_trns[0]
            issuer_name_from_favour = None

        trn, name = chosen
        issuer_trn = trn
        issuer_name = name or issuer_name_from_favour
        # Other labelled TRN → customer candidate
        for other_trn, other_name in labelled_trns:
            if other_trn != issuer_trn:
                if not customer_trn:
                    customer_trn = other_trn
                if other_name and not customer_name and not labelled_customer:
                    customer_name = other_name
                break
        if favour and name and not _names_match(name, favour) and issuer_name_from_favour:
            # Labelled name near chosen TRN disagrees with payment favour
            if not any(n and _names_match(n, favour) for _, n in labelled_trns):
                flags.append("party_roles_uncertain")
                role_conf = min(role_conf, 0.45)
            else:
                issuer_name = favour
        elif favour and not name:
            issuer_name = favour
        elif not name:
            # TAX INVOICE classic: line after title
            m_iss = re.search(r"(?i)TAX\s+INVOICE\s*\n([^\n]+)", text)
            if m_iss:
                candidate = m_iss.group(1).strip()
                if not re.match(r"(?i)^(trn|bill\s*to|invoice|date|فاتورة)\b", candidate):
                    issuer_name = candidate

    # Geometry header blocks (left/right) refine unlabelled layouts
    blocks = _header_blocks_from_words(word_boxes or [], 1) if word_boxes else []
    if blocks and not flags:
        issuer_block = None
        other_blocks = []
        for b in blocks:
            is_iss = False
            if issuer_trn and issuer_trn in b["trns"]:
                is_iss = True
            if favour and any(_names_match(n, favour) for n in b["names"]):
                is_iss = True
            if issuer_name and any(_names_match(n, issuer_name) for n in b["names"]):
                is_iss = True
            if is_iss:
                issuer_block = b
            else:
                other_blocks.append(b)
        if issuer_block:
            if not issuer_name and issuer_block["names"]:
                issuer_name = issuer_block["names"][0]
            if not issuer_trn and issuer_block["trns"]:
                issuer_trn = issuer_block["trns"][0]
            if favour and issuer_block["names"] and not any(
                _names_match(n, favour) for n in issuer_block["names"]
            ):
                if favour and issuer_trn:
                    # TRN side doesn't match payment name
                    flags.append("party_roles_uncertain")
                    role_conf = min(role_conf, 0.45)
        # (c) unlabelled other header block → customer when no label
        if not labelled_customer and other_blocks:
            ob = other_blocks[0]
            if ob["names"] and not customer_name:
                customer_name = ob["names"][0]
            if ob["trns"] and not customer_trn:
                # Prefer a TRN that isn't the issuer's
                for t in ob["trns"]:
                    if t != issuer_trn:
                        customer_trn = t
                        break
                if not customer_trn:
                    customer_trn = ob["trns"][0]

    # (b) labelled customer
    if labelled_customer:
        if customer_name and not _names_match(customer_name, labelled_customer):
            flags.append("party_roles_uncertain")
            role_conf = min(role_conf, 0.45)
        else:
            customer_name = labelled_customer

    # Classic text fallbacks when geometry empty
    if not issuer_name:
        m_iss = re.search(r"(?i)TAX\s+INVOICE\s*\n([^\n]+)", text)
        if m_iss:
            candidate = m_iss.group(1).strip()
            if not re.match(r"(?i)^(trn|bill\s*to|invoice|date|فاتورة)\b", candidate):
                issuer_name = candidate

    if not customer_name and not labelled_customer:
        # Unlabelled: first name candidate that isn't the issuer
        for cand in _line_name_candidates(header):
            if issuer_name and _names_match(cand, issuer_name):
                continue
            if favour and _names_match(cand, favour):
                continue
            customer_name = cand
            break

    # TRN assignment: issuer header vs after Bill To / other
    header_trns = find_trns(header)
    after_trns = find_trns(after)
    all_trns = find_trns(text)

    if not issuer_trn and header_trns:
        issuer_trn = header_trns[0]
    if not customer_trn:
        for t in after_trns + all_trns:
            if t != issuer_trn:
                customer_trn = t
                break
    if not issuer_trn and all_trns:
        issuer_trn = all_trns[0]
        if len(all_trns) > 1 and not customer_trn:
            customer_trn = all_trns[1]

    # Conflict: labelled customer equals favour / issuer
    if (
        labelled_customer
        and favour
        and _names_match(labelled_customer, favour)
        and issuer_name
        and _names_match(issuer_name, favour)
    ):
        # Same party on both sides — uncertain
        flags.append("party_roles_uncertain")
        role_conf = min(role_conf, 0.45)

    if "party_roles_uncertain" in flags:
        # De-dupe while preserving order
        flags = list(dict.fromkeys(flags))

    return issuer_name, issuer_trn, customer_name, customer_trn, flags, role_conf


def _word_center(w: dict[str, Any]) -> tuple[float, float]:
    return (
        (float(w["x0"]) + float(w["x1"])) / 2,
        (float(w["y0"]) + float(w["y1"])) / 2,
    )


def _find_label_anchor(
    words: list[dict[str, Any]], tokens: tuple[str, ...]
) -> list[dict[str, Any]] | None:
    """Find consecutive/nearby words matching label tokens (same line or stacked)."""
    norm = [str(w.get("text") or "").strip().casefold().rstrip(".:") for w in words]
    n = len(tokens)
    for i in range(len(words)):
        if norm[i] != tokens[0]:
            continue
        matched = [words[i]]
        last = words[i]
        ti = 1
        for j in range(i + 1, min(i + 12, len(words))):
            if ti >= n:
                break
            t = norm[j]
            if t != tokens[ti]:
                # Allow gap words that are tiny connectors
                if t in {"", ":", "-", "no", "no."} and tokens[ti] in {t, "no", "no.", "number"}:
                    if t in {tokens[ti], "no", "no."} and t == tokens[ti]:
                        matched.append(words[j])
                        last = words[j]
                        ti += 1
                    continue
                # Stacked: next token roughly below previous
                lx, ly = _word_center(last)
                cx, cy = _word_center(words[j])
                if t == tokens[ti] and cy >= ly - 2 and abs(cx - lx) < 80:
                    matched.append(words[j])
                    last = words[j]
                    ti += 1
                continue
            # Same-line match to the right
            lx, ly = _word_center(last)
            cx, cy = _word_center(words[j])
            if abs(cy - ly) <= 8 and cx >= lx - 2:
                matched.append(words[j])
                last = words[j]
                ti += 1
            elif cy >= ly - 2 and abs(cx - lx) < 80:
                matched.append(words[j])
                last = words[j]
                ti += 1
        if ti >= n:
            return matched
    return None


def _value_right_or_below(
    words: list[dict[str, Any]],
    label_words: list[dict[str, Any]],
    *,
    predicate,
) -> tuple[str, list[dict[str, Any]]] | None:
    """Nearest value word(s) to the right of or below the label bbox."""
    bx0, by0, bx1, by1 = _union_bbox(label_words)
    cx = (bx0 + bx1) / 2
    cy = (by0 + by1) / 2
    candidates: list[tuple[float, list[dict[str, Any]], str]] = []

    # Right: same row
    row = [
        w
        for w in words
        if abs(((float(w["y0"]) + float(w["y1"])) / 2) - cy) <= 10
        and float(w["x0"]) >= bx1 - 2
    ]
    row.sort(key=lambda w: float(w["x0"]))
    if row:
        # Take a run of tokens that satisfy predicate when joined
        for end in range(1, min(6, len(row) + 1)):
            chunk = row[:end]
            joined = " ".join(str(w.get("text") or "") for w in chunk)
            if predicate(joined):
                dist = float(chunk[0]["x0"]) - bx1
                candidates.append((dist, chunk, joined))
                break

    # Below: similar x, greater y
    below = [
        w
        for w in words
        if float(w["y0"]) >= by1 - 2
        and abs(((float(w["x0"]) + float(w["x1"])) / 2) - cx) < 120
    ]
    below.sort(key=lambda w: (float(w["y0"]), float(w["x0"])))
    if below:
        # First non-empty row below
        first_y = float(below[0]["y0"])
        row_b = [w for w in below if abs(float(w["y0"]) - first_y) <= 8]
        for end in range(1, min(6, len(row_b) + 1)):
            chunk = row_b[:end]
            joined = " ".join(str(w.get("text") or "") for w in chunk)
            if predicate(joined):
                dist = 1000 + (float(chunk[0]["y0"]) - by1)
                candidates.append((dist, chunk, joined))
                break
        # Also try skipping label-like first word ("Number" already in label)
        if len(row_b) >= 2:
            for start in range(1, min(3, len(row_b))):
                for end in range(start + 1, min(start + 6, len(row_b) + 1)):
                    chunk = row_b[start:end]
                    joined = " ".join(str(w.get("text") or "") for w in chunk)
                    if predicate(joined):
                        dist = 1000 + (float(chunk[0]["y0"]) - by1) + start
                        candidates.append((dist, chunk, joined))
                        break

    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0])
    _, chunk, joined = candidates[0]
    return joined.strip(), chunk


def _invoice_no_predicate(value: str) -> bool:
    v = value.strip()
    if not v or len(v) < 2:
        return False
    if re.fullmatch(DATE_TOKEN, v, re.I):
        return False
    if AMOUNT_TOKEN_RE.fullmatch(v):
        return False
    if v.casefold() in {
        "number",
        "no",
        "no.",
        "date",
        "invoice",
        "bill",
        "total",
        "amount",
        "description",
        "quantity",
        "rate",
        "tax",
        "aed",
    }:
        return False
    return bool(re.match(r"^[A-Z0-9][A-Z0-9\-/]*$", v, re.I))


def find_invoice_number(
    blob: str,
    word_boxes: list[dict[str, Any]],
    prefer_pages: list[int],
) -> tuple[str | None, dict[str, Any] | None]:
    """Regex first; else word-box geometry nearest right/below stacked labels."""
    inv = INV_RE.search(blob)
    if inv:
        val = inv.group(1)
        src = find_source(word_boxes, val, prefer_pages=prefer_pages) if word_boxes else None
        return val, src

    pages = prefer_pages or sorted(
        {int(w["page"]) for w in word_boxes if "text" in w and "x0" in w}
    )
    for p in pages:
        words = words_on_page(word_boxes, p)
        if not words:
            continue
        for tokens in INV_LABEL_TOKENS:
            anchor = _find_label_anchor(words, tokens)
            if not anchor:
                continue
            hit = _value_right_or_below(words, anchor, predicate=_invoice_no_predicate)
            if hit:
                val, chunk = hit
                return val, {"page": p, "bbox": _union_bbox(chunk)}
        # Single-token "Invoice" with value below that looks like INV-…
        for w in words:
            if str(w.get("text") or "").casefold().rstrip(".:") != "invoice":
                continue
            hit = _value_right_or_below(words, [w], predicate=_invoice_no_predicate)
            if hit:
                val, chunk = hit
                # Prefer INV- style when multiple
                if re.search(r"[A-Z]{2,}|-|\d{3,}", val, re.I):
                    return val, {"page": p, "bbox": _union_bbox(chunk)}
    return None, None


def infer_vat_code(evidence: str | None) -> str | None:
    """Map document evidence to SR/ZR/EX/OOS; never default."""
    if not evidence:
        return None
    for pattern, code in VAT_CODE_PATTERNS:
        if pattern.search(evidence):
            return code
    return None


def _parse_line_items_from_words(
    word_boxes: list[dict[str, Any]],
    page_texts: list[str],
    *,
    base_conf: float,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Parse Description|Qty|Rate|Tax|Amount table via word boxes; flags for missing VAT."""
    flags: list[str] = []
    pages = sorted({int(w["page"]) for w in word_boxes if "text" in w and "x0" in w})
    for p in pages:
        words = words_on_page(word_boxes, p)
        if not words:
            continue
        # Find header row containing Description and Amount
        by_y: dict[int, list[dict[str, Any]]] = {}
        for w in words:
            key = int(round(float(w["y0"]) / 5) * 5)
            by_y.setdefault(key, []).append(w)
        header_y = None
        header_cols: dict[str, float] = {}
        for y, row in sorted(by_y.items()):
            texts = [str(w.get("text") or "").casefold() for w in row]
            joined = " ".join(texts)
            if "description" not in joined:
                continue
            if "amount" not in joined and not any("amount" in t for t in texts):
                continue
            header_y = y
            for w in row:
                t = str(w.get("text") or "").casefold().rstrip(".:")
                cx = (float(w["x0"]) + float(w["x1"])) / 2
                if t.startswith("desc"):
                    header_cols["description"] = cx
                elif t in {"qty", "quantity", "quanity"}:
                    header_cols["qty"] = cx
                elif t == "rate":
                    header_cols["rate"] = cx
                elif t in {"tax", "vat"}:
                    header_cols["tax"] = cx
                elif t.startswith("amount"):
                    header_cols["amount"] = cx
            break
        if header_y is None or "description" not in header_cols or "amount" not in header_cols:
            continue

        # Data rows until totals
        lines: list[dict[str, Any]] = []
        for y, row in sorted(by_y.items()):
            if y <= header_y + 5:
                continue
            row = sorted(row, key=lambda w: float(w["x0"]))
            joined = " ".join(str(w.get("text") or "") for w in row)
            if re.match(
                r"(?i)^(subtotal|total|vat|grand|amount\s+due|invoice\s+total|"
                r"payment|bank|iban|account)\b",
                joined.strip(),
            ):
                break
            if not joined.strip():
                continue

            def nearest(col: str) -> list[dict[str, Any]]:
                if col not in header_cols:
                    return []
                target = header_cols[col]
                # Words whose center is closest to column among this row
                scored = sorted(
                    row,
                    key=lambda w: abs(((float(w["x0"]) + float(w["x1"])) / 2) - target),
                )
                # Keep words within column band
                band = [
                    w
                    for w in row
                    if abs(((float(w["x0"]) + float(w["x1"])) / 2) - target) < 55
                ]
                return band if band else ([scored[0]] if scored else [])

            desc_words = nearest("description")
            # Description is often left-aligned multi-word: take words left of qty/rate/tax/amount
            amount_x = header_cols["amount"]
            left_bound = min(
                header_cols.get("qty", amount_x),
                header_cols.get("rate", amount_x),
                header_cols.get("tax", amount_x),
                amount_x,
            )
            desc_words = [w for w in row if float(w["x1"]) < left_bound - 5]
            if not desc_words:
                desc_words = nearest("description")
            description = " ".join(str(w.get("text") or "") for w in desc_words).strip()
            if not description or len(description) < 2:
                continue

            qty = None
            rate = None
            tax_text = ""
            amount_raw = None
            amount_words: list[dict[str, Any]] = []

            if "qty" in header_cols:
                qw = nearest("qty")
                if qw:
                    qt = str(qw[0].get("text") or "")
                    if QTY_TOKEN_RE.fullmatch(qt):
                        qty = float(qt) if "." in qt else int(qt)
            if "rate" in header_cols:
                rw = nearest("rate")
                if rw:
                    rt = str(rw[0].get("text") or "").replace(",", "")
                    if AMOUNT_TOKEN_RE.fullmatch(str(rw[0].get("text") or "")) or re.fullmatch(
                        r"[\d,]+\.\d{2}", str(rw[0].get("text") or "")
                    ):
                        rate = parse_amount_fils(str(rw[0].get("text") or ""))
            if "tax" in header_cols:
                tw = nearest("tax")
                tax_text = " ".join(str(w.get("text") or "") for w in tw).strip()
            aw = nearest("amount")
            for w in aw:
                t = str(w.get("text") or "")
                if AMOUNT_TOKEN_RE.fullmatch(t):
                    amount_raw = t
                    amount_words = [w]
                    break
            if amount_raw is None:
                # Last amount-like token on the row
                for w in reversed(row):
                    t = str(w.get("text") or "")
                    if AMOUNT_TOKEN_RE.fullmatch(t):
                        amount_raw = t
                        amount_words = [w]
                        break
            if amount_raw is None:
                continue

            vat_code = infer_vat_code(tax_text) or infer_vat_code(joined)
            if vat_code is None:
                flags.append("vat_code_missing")
            net = parse_amount_fils(amount_raw)
            src_words = desc_words + amount_words
            source = {"page": p, "bbox": _union_bbox(src_words)} if src_words else None
            lines.append(
                {
                    "description": description,
                    "qty": qty,
                    "rate": rate,
                    "vat_code": vat_code,
                    "net": net,
                    "amount_minor": net,
                    "confidence": base_conf if vat_code else min(base_conf, 0.7),
                    "source": source if _has_valid_source(source) else None,
                }
            )
        if lines:
            flags = list(dict.fromkeys(flags))
            return lines, flags

    # Text-row fallback without full table geometry
    return [], flags


def _fallback_line_item(
    *,
    net: int | None,
    gross: int | None,
    page_texts: list[str],
    word_boxes: list[dict[str, Any]],
    base_conf: float,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Single fallback line — description always 'Invoice total', never filename."""
    flags: list[str] = []
    blob = "\n".join(page_texts)
    vat_code = infer_vat_code(blob)
    # Prefer line-level evidence snippets
    for raw in blob.splitlines():
        code = infer_vat_code(raw)
        if code:
            vat_code = code
            break
    if vat_code is None:
        flags.append("vat_code_missing")
    amount = net if net is not None else gross
    if amount is None:
        amount = 0
    src = find_source(word_boxes, "Invoice total") if word_boxes else None
    # Prefer source on the amount itself
    if amount and word_boxes:
        raw_amt = f"{amount / 100:.2f}"
        pages = list(range(len(page_texts), 0, -1))
        src = find_source(word_boxes, raw_amt, prefer_pages=pages) or src
    return (
        [
            {
                "description": "Invoice total",
                "qty": None,
                "rate": None,
                "vat_code": vat_code,
                "net": amount,
                "amount_minor": amount,
                "confidence": base_conf if vat_code else min(base_conf, 0.7),
                "source": src if _has_valid_source(src) else None,
            }
        ],
        flags,
    )


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
    Line vat_code comes only from document evidence (SR/ZR/EX/OOS); else null + flag.
    """
    base_conf = 0.99 if route == "text" else 0.96
    pages = page_texts if page_texts is not None else [text or ""]
    boxes = word_boxes or []
    blob = "\n".join(pages) if pages else (text or "")
    prefer_first = list(range(1, len(pages) + 1))
    prefer_last = list(range(len(pages), 0, -1))
    flags: list[str] = []

    out: dict[str, Any] = {"route": route, "fields": {}, "flags": flags}

    inv_val, inv_src = find_invoice_number(blob, boxes, prefer_first)
    if inv_val:
        out["invoice_no"] = inv_val
        out["document_number"] = inv_val
        out["fields"]["invoice_no"] = _located(inv_val, base_conf, inv_src)
        out["fields"]["document_number"] = _located(inv_val, base_conf, inv_src)
    else:
        out["fields"]["invoice_no"] = _missing(0.2)
        out["fields"]["document_number"] = _missing(0.2)

    date_m = DATE_LABEL_RE.search(blob) or DATE_ANY_RE.search(blob)
    if date_m:
        raw = date_m.group(1)
        iso, scale, ambiguous = parse_invoice_date(raw)
        if iso:
            conf = base_conf * scale
            if ambiguous:
                flags.append("date_ambiguous_dd_mm")
            src = find_source(boxes, raw, prefer_pages=prefer_first) if boxes else None
            if not src and boxes:
                # Date may be split across words ("28" "Jan" "2026")
                src = find_source(boxes, raw.split()[0], prefer_pages=prefer_first)
            out["invoice_date"] = iso
            out["document_date"] = iso
            out["fields"]["invoice_date"] = _located(iso, conf, src)
            out["fields"]["document_date"] = _located(iso, conf, src)
        else:
            out["fields"]["invoice_date"] = _missing(0.2)
            out["fields"]["document_date"] = _missing(0.2)
    else:
        out["fields"]["invoice_date"] = _missing(0.2)
        out["fields"]["document_date"] = _missing(0.2)

    (
        issuer_name,
        issuer_trn,
        customer_name,
        customer_trn,
        role_flags,
        role_conf,
    ) = _issuer_customer(pages, boxes)
    flags.extend(role_flags)
    party_conf = min(base_conf, role_conf)

    if issuer_name:
        src = find_source(boxes, issuer_name, prefer_pages=prefer_first) if boxes else None
        out["issuer_name"] = issuer_name
        out["fields"]["issuer_name"] = _located(issuer_name, party_conf, src)
    else:
        out["fields"]["issuer_name"] = _missing()

    if issuer_trn:
        src = find_source(boxes, issuer_trn, prefer_pages=prefer_first) if boxes else None
        out["supplier_trn"] = issuer_trn
        out["issuer_trn"] = issuer_trn
        out["fields"]["supplier_trn"] = _located(issuer_trn, party_conf, src)
        out["fields"]["issuer_trn"] = _located(issuer_trn, party_conf, src)
    else:
        out["fields"]["supplier_trn"] = _missing(0.2)
        out["fields"]["issuer_trn"] = _missing(0.2)

    if customer_name:
        src = find_source(boxes, customer_name, prefer_pages=prefer_first) if boxes else None
        out["customer_name"] = customer_name
        out["fields"]["customer_name"] = _located(customer_name, party_conf, src)
    else:
        out["fields"]["customer_name"] = _missing()

    if customer_trn:
        src = find_source(boxes, customer_trn, prefer_pages=prefer_first) if boxes else None
        out["customer_trn"] = customer_trn
        out["fields"]["customer_trn"] = _located(customer_trn, party_conf, src)
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
    # Explicit zero-tax totals when label/value are stacked on separate lines.
    if not vat_hit:
        for idx in range(len(pages) - 1, -1, -1):
            m = re.search(
                r"(?im)^(?:Total\s+No\s+Tax(?:\s*0\s*%?)?|VAT\s*0\s*%?)"
                r"(?:\s+AED)?\s*\n\s*([\d,]+\.\d{2})\s*$",
                pages[idx] or "",
            )
            if m:
                vat_hit = (m.group(1), idx + 1)
                break
            m = re.search(
                r"(?im)^(?:Total\s+No\s+Tax(?:\s*0\s*%?)?|VAT\s*0\s*%?)"
                r"(?:\s+AED)?\s+([\d,]+\.\d{2})\s*$",
                pages[idx] or "",
            )
            if m:
                vat_hit = (m.group(1), idx + 1)
                break

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

    # Line items (table via word_boxes, else Invoice total fallback)
    line_items, line_flags = _parse_line_items_from_words(
        boxes, pages, base_conf=base_conf
    )
    if not line_items:
        line_items, line_flags = _fallback_line_item(
            net=out.get("net"),
            gross=out.get("gross"),
            page_texts=pages,
            word_boxes=boxes,
            base_conf=base_conf,
        )
    flags.extend(line_flags)
    flags[:] = list(dict.fromkeys(flags))
    out["flags"] = flags
    out["line_items"] = line_items
    # Keep fields_json shape for the list as a whole
    line_src = None
    if line_items and _has_valid_source(line_items[0].get("source")):
        line_src = line_items[0]["source"]
    out["fields"]["line_items"] = _located(line_items, base_conf, line_src)

    return out
