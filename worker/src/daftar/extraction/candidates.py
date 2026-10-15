"""Scored field candidates (not first-match) for invoice/bill extraction."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from daftar.extraction.layout import key_value_pairs_from_lines, page_lines, union_bbox
from daftar.textnorm import arabic_indic_to_ascii

TRN_RE = re.compile(r"(?<!\d)(100\d{12})(?!\d)")
DATE_RE = re.compile(
    r"\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b",
    re.I,
)
AMOUNT_RE = re.compile(r"\(?-?[\d,]+\.\d{2}\)?")
CURRENCY_RE = re.compile(r"\b(AED|USD|EUR|GBP|SAR)\b", re.I)

TRN_LABEL = re.compile(r"(?i)\b(TRN|Tax\s*Registration|VAT\s*No|الرقم\s*الضريبي)\b")
DATE_LABEL = re.compile(r"(?i)\b(Invoice\s*Date|Date|Issue\s*Date|التاريخ)\b")
TOTAL_LABEL = re.compile(r"(?i)\b(Grand\s*Total|Invoice\s*Total|Total\s*Due|Amount\s*Due|الإجمالي)\b")
PROFORMA_RE = re.compile(r"(?i)\bpro[\s\-]?forma\b|\bquotation\b|\bestimate\b")
CN_RE = re.compile(r"(?i)\bcredit\s*note\b|\bCN[\-\s]?\d")
DN_RE = re.compile(r"(?i)\bdebit\s*note\b|\bDN[\-\s]?\d")


@dataclass
class Candidate:
    value: str
    score: float
    page: int | None = None
    bbox: list[float] | None = None
    reason: str = ""


def _near_label_bonus(text_before: str, label_re: re.Pattern[str]) -> float:
    # Only the immediate left context counts — avoid picking up labels from prior lines.
    window = text_before[-48:] if text_before else ""
    # Prefer the last label match closest to the value.
    matches = list(label_re.finditer(window))
    if not matches:
        return 0.0
    m = matches[-1]
    # Require the label to end near the value (colon/space gap).
    gap = window[m.end() :]
    if len(gap) > 12:
        return 0.0
    label = m.group(0).lower()
    # Prefer explicit "Tax Registration" / "Invoice Date" over a bare token.
    if "tax" in label or "registration" in label or "invoice" in label or "الرقم" in label:
        return 0.42
    return 0.22


def score_trn_candidates(text: str, word_boxes: list[dict[str, Any]] | None = None) -> list[Candidate]:
    blob = arabic_indic_to_ascii(text or "")
    cands: list[Candidate] = []
    for m in TRN_RE.finditer(blob):
        val = m.group(1)
        score = 0.50 + _near_label_bonus(blob[: m.start()], TRN_LABEL)
        if val.startswith("100"):
            score += 0.05
        # Colon / Number immediately before is a strong key/value signal.
        prefix = blob[max(0, m.start() - 40) : m.start()]
        if re.search(r"(?i)(number|no\.?|trn)\s*[:：]\s*$", prefix):
            score += 0.25
        page, bbox = _locate(word_boxes, val)
        cands.append(Candidate(val, min(0.99, score), page, bbox, "trn_pattern"))
    # Key/value lines from geometry
    if word_boxes:
        pages = sorted({int(w["page"]) for w in word_boxes if "text" in w and "x0" in w})
        for p in pages:
            for key, val in key_value_pairs_from_lines(page_lines(word_boxes, p)):
                if TRN_LABEL.search(key):
                    digits = re.sub(r"\D", "", arabic_indic_to_ascii(val))
                    if len(digits) == 15 and digits.startswith("100"):
                        page, bbox = _locate(word_boxes, digits) or (p, None)
                        cands.append(Candidate(digits, 0.96, page, bbox, "trn_kv"))
    # Text-only key/value (no boxes): "Tax Registration Number: …"
    for m in re.finditer(
        r"(?i)(?:TRN|Tax\s*Registration(?:\s*Number)?|VAT\s*No)\s*[:：]\s*(100\d{12})",
        blob,
    ):
        cands.append(Candidate(m.group(1), 0.97, None, None, "trn_kv_text"))
    return _dedupe_best(cands)


def score_date_candidates(text: str, word_boxes: list[dict[str, Any]] | None = None) -> list[Candidate]:
    blob = arabic_indic_to_ascii(text or "")
    cands: list[Candidate] = []
    for m in DATE_RE.finditer(blob):
        raw = m.group(1)
        score = 0.5 + _near_label_bonus(blob[: m.start()], DATE_LABEL)
        # Prefer dd/mm/yyyy style UAE dates over ISO slightly when labeled.
        if re.match(r"\d{1,2}/\d{1,2}/\d{4}$", raw):
            score += 0.08
        page, bbox = _locate(word_boxes, raw.split()[0] if " " in raw else raw)
        cands.append(Candidate(raw, min(0.99, score), page, bbox, "date_pattern"))
    return _dedupe_best(cands)


def score_amount_candidates(
    text: str,
    *,
    label_re: re.Pattern[str] = TOTAL_LABEL,
    word_boxes: list[dict[str, Any]] | None = None,
) -> list[Candidate]:
    blob = arabic_indic_to_ascii(text or "")
    cands: list[Candidate] = []
    for m in AMOUNT_RE.finditer(blob):
        raw = m.group(0)
        score = 0.4 + _near_label_bonus(blob[: m.start()], label_re)
        page, bbox = _locate(word_boxes, raw)
        cands.append(Candidate(raw, min(0.99, score), page, bbox, "amount_near_label"))
    return _dedupe_best(cands)


def score_currency_candidates(text: str) -> list[Candidate]:
    blob = arabic_indic_to_ascii(text or "")
    cands: list[Candidate] = []
    for m in CURRENCY_RE.finditer(blob):
        cands.append(Candidate(m.group(1).upper(), 0.9, None, None, "currency"))
    return _dedupe_best(cands)


def document_kind_flags(text: str) -> list[str]:
    """Proforma / credit-note / debit-note markers for review."""
    blob = arabic_indic_to_ascii(text or "")
    flags: list[str] = []
    if PROFORMA_RE.search(blob):
        flags.append("proforma_or_quote")
    if CN_RE.search(blob):
        flags.append("credit_note")
    if DN_RE.search(blob):
        flags.append("debit_note")
    return flags


def pick_best(cands: list[Candidate]) -> Candidate | None:
    if not cands:
        return None
    return sorted(cands, key=lambda c: (-c.score, c.value))[0]


def _locate(
    word_boxes: list[dict[str, Any]] | None, needle: str
) -> tuple[int | None, list[float] | None]:
    if not word_boxes or not needle:
        return None, None
    target = arabic_indic_to_ascii(needle).replace(" ", "").lower()
    for w in word_boxes:
        if "text" not in w or "x0" not in w:
            continue
        t = arabic_indic_to_ascii(str(w["text"])).replace(" ", "").lower()
        if t == target or target in t:
            return int(w["page"]), [
                float(w["x0"]),
                float(w["y0"]),
                float(w["x1"]),
                float(w["y1"]),
            ]
    # Multi-word: try first token
    first = needle.split()[0]
    if first != needle:
        return _locate(word_boxes, first)
    return None, None


def _dedupe_best(cands: list[Candidate]) -> list[Candidate]:
    best: dict[str, Candidate] = {}
    for c in cands:
        key = c.value.strip().lower()
        prev = best.get(key)
        if prev is None or c.score > prev.score:
            best[key] = c
    return sorted(best.values(), key=lambda c: (-c.score, c.value))
