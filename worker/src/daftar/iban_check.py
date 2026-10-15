"""IBAN normalisation + ISO 13616 mod-97 check (Addendum A §3)."""

from __future__ import annotations

from daftar.textnorm import arabic_indic_to_ascii


def normalize_iban(raw: str | None) -> str:
    text = arabic_indic_to_ascii(raw or "")
    return "".join(ch for ch in text if not ch.isspace() and ch != "-").upper()


def is_valid_iban(raw: str | None) -> bool:
    """True when structure + mod-97 check digit are valid."""
    cleaned = normalize_iban(raw)
    if len(cleaned) < 15 or len(cleaned) > 34:
        return False
    if not cleaned[:2].isalpha() or not cleaned[2:4].isdigit():
        return False
    if not all(ch.isalnum() for ch in cleaned):
        return False
    rearranged = cleaned[4:] + cleaned[:4]
    expanded: list[str] = []
    for ch in rearranged:
        if ch.isalpha():
            expanded.append(str(ord(ch) - 55))
        else:
            expanded.append(ch)
    digits = "".join(expanded)
    remainder = 0
    for ch in digits:
        remainder = (remainder * 10 + int(ch)) % 97
    return remainder == 1
