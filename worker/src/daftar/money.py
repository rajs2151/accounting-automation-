"""Money is integer minor units at a scale of 2, plus a currency code.

That scale is one fils when the currency is quoted to two decimal places,
which is the case for AED. KWD, BHD, and OMR are quoted to three decimal
places. A third decimal raises ``amount_precision`` instead of being rounded
or truncated, so those currencies are not stored in Phase 1.

Floats are rejected at this boundary. Binary floating point cannot represent
most decimal cents, so a float is never accepted as an amount.
"""

from __future__ import annotations

import re
from typing import Any


THREE_DECIMAL_CURRENCIES = frozenset({"KWD", "BHD", "OMR"})


class MoneyError(ValueError):
    def __init__(self, code: str = "bad_amount"):
        super().__init__(code)
        self.code = code


def parse_amount(
    raw: Any,
    *,
    decimal_sep: str = ".",
    thousands_sep: str = ",",
) -> int | None:
    """Parse a decimal string into minor units. Blank means the side is empty."""
    from daftar.textnorm import arabic_indic_to_ascii

    if raw is None:
        return None
    if isinstance(raw, float):
        raise TypeError("money must not be a float")
    if isinstance(raw, bool) or not isinstance(raw, str):
        raise TypeError("money must be a decimal string")

    text = arabic_indic_to_ascii(raw).strip()
    if text in {"", "-", "—", "–", "n/a", "N/A"}:
        return None

    negative = False
    if text.startswith("(") and text.endswith(")"):
        negative = True
        text = text[1:-1].strip()

    upper = text.upper().replace(" ", "")
    for suffix, is_debit in (("DR", True), ("CR", False)):
        if upper.endswith(suffix):
            if is_debit:
                negative = True
            text = text[: -len(suffix)].strip()
            break
    for suffix in ("مدين", "دائن"):
        if text.endswith(suffix):
            if suffix == "مدين":
                negative = True
            text = text[: -len(suffix)].strip()
            break

    text = text.replace(" ", "").replace("\u00a0", "")
    text = re.sub(r"^[A-Za-z]{3}", "", text)
    if text.startswith("+"):
        text = text[1:]
    if text.startswith("-"):
        negative = True
        text = text[1:]
    if thousands_sep and thousands_sep != decimal_sep:
        text = text.replace(thousands_sep, "")
    if decimal_sep != ".":
        text = text.replace(decimal_sep, ".")
    if not re.fullmatch(r"\d+(\.\d+)?", text):
        raise MoneyError("bad_amount")
    if "." in text:
        major, frac = text.split(".", 1)
        # "1.230" is rejected. A trailing zero is still a third decimal place,
        # so it is not trimmed and accepted as 1.23.
        if len(frac) > 2:
            raise MoneyError("amount_precision")
        frac = frac.ljust(2, "0")
    else:
        major, frac = text, "00"
    minor = int(major) * 100 + int(frac)
    return -minor if negative else minor


def decimal_string_from_excel(value: float) -> str:
    """Turn an Excel binary float into a decimal string when it is an exact cent.

    Spreadsheet libraries surface numeric cells as floats. This helper is the
    only place a float is tolerated, and it refuses values that are not within
    a tenth of a fils of a whole cent. `parse_amount` still rejects floats.
    """
    if isinstance(value, bool) or not isinstance(value, float):
        raise TypeError("expected an Excel float")
    cents = value * 100.0
    nearest = round(cents)
    if abs(cents - nearest) > 1e-3:
        raise MoneyError("inexact_spreadsheet_amount")
    sign = "-" if nearest < 0 else ""
    nearest = abs(int(nearest))
    return f"{sign}{nearest // 100}.{nearest % 100:02d}"
