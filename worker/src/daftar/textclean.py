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
