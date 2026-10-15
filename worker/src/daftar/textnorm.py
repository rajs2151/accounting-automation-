"""Addendum A §3 text helpers: Arabic-Indic digits → ASCII, light bilingual cleanup."""

from __future__ import annotations

import re

# Western Arabic-Indic (U+0660–U+0669) and Eastern Arabic-Indic (U+06F0–U+06F9).
_ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩"
_EASTERN_ARABIC = "۰۱۲۳۴۵۶۷۸۹"
_ARABIC_LABEL_DUP = re.compile(
    r"(?iu)\b("
    r"فاتورة|ضريبة|المورد|العميل|الإجمالي|المجموع|التاريخ|الرقم"
    r")\b"
)


def arabic_indic_to_ascii(input_text: str | None) -> str:
    """Map Arabic-Indic / Eastern Arabic digits to ASCII 0–9; leave other chars."""
    if not input_text:
        return ""
    out: list[str] = []
    for ch in str(input_text):
        i1 = _ARABIC_INDIC.find(ch)
        if i1 >= 0:
            out.append(str(i1))
            continue
        i2 = _EASTERN_ARABIC.find(ch)
        if i2 >= 0:
            out.append(str(i2))
            continue
        out.append(ch)
    return "".join(out)


def normalize_extract_text(input_text: str | None) -> str:
    """Digits to ASCII; collapse runs of whitespace. Does not strip Arabic letters."""
    text = arabic_indic_to_ascii(input_text)
    return re.sub(r"[ \t]+", " ", text).strip() if text else ""


def strip_duplicated_arabic_labels(line: str) -> str:
    """Prefer English on bilingual key lines; drop lone duplicated Arabic label tokens."""
    s = normalize_extract_text(line)
    if not s:
        return s
    # If the line also has Latin letters, remove Arabic label words that duplicate EN labels.
    if re.search(r"[A-Za-z]", s):
        s = _ARABIC_LABEL_DUP.sub("", s)
        s = re.sub(r"[ \t]{2,}", " ", s).strip(" -|:،;")
    return s
