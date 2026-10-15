"""Make extracted text safe to store and detect garbled PDF text layers.

PDFs from invoicing/accounting software often use CID / Identity-H fonts without a ToUnicode map. Their text layer
then decodes to NUL bytes, control characters or U+FFFD instead of real text. Postgres rejects NUL in text and
"\\u0000" in jsonb, which used to fail the whole upload.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

# C0 controls except tab/newline/carriage return, DEL, C1 controls.
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_BAD = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f�-]")
_SURROGATE = re.compile(r"[\ud800-\udfff]")


def clean_text(value: str) -> str:
    """Strip NUL/control characters and lone surrogates, normalise to NFC. Never raises."""
    if not value:
        return value
    value = _SURROGATE.sub("", value)
    value = _CONTROL.sub("", value)
    return unicodedata.normalize("NFC", value)


def garbled_ratio(text: str) -> float:
    """Share of non-whitespace characters that are NUL/control, U+FFFD or private-use (unmapped glyphs)."""
    compact = re.sub(r"\s+", "", text or "")
    if not compact:
        return 0.0
    return len(_BAD.findall(compact)) / len(compact)


def text_layer_unreliable(text: str, threshold: float = 0.2) -> bool:
    """True when a page's text layer is mostly unmapped glyphs and should go to OCR instead."""
    return garbled_ratio(text) > threshold


def page_has_usable_text_layer(
    text: str,
    *,
    min_chars: int | None = None,
    word_count: int = 0,
) -> bool:
    """One rule for extract / pdf_words / ocr_engine: usable text layer → skip OCR.

    Unreliable (garbled / unmapped-font) layers always OCR. Otherwise a page is
    digital text when it has enough characters **or** enough real words (short
    totals-only pages on multi-page invoices). Empty/tiny layers (scans) OCR.
    """
    import os

    minimum = min_chars if min_chars is not None else int(os.environ.get("PDF_PROBE_MIN_CHARS", "30"))
    if text_layer_unreliable(text):
        return False
    compact = re.sub(r"\s+", "", text or "")
    if len(compact) >= minimum:
        return True
    # Short but real digital pages (e.g. page-2 totals) still have word tokens.
    return word_count >= 3


def clean_param(value: Any) -> Any:
    """Recursively clean DB parameters. JSON strings may carry escaped NULs ("\\u0000"), which jsonb rejects."""
    if isinstance(value, str):
        return clean_text(value).replace("\\u0000", "")
    if isinstance(value, tuple):
        return tuple(clean_param(v) for v in value)
    if isinstance(value, list):
        return [clean_param(v) for v in value]
    if isinstance(value, dict):
        return {k: clean_param(v) for k, v in value.items()}
    return value
