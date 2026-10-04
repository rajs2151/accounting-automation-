"""Company match → Unassigned when TRN/IBAN/name do not match (Addendum A §4)."""

from __future__ import annotations

import re
from dataclasses import dataclass

TRN_RE = re.compile(r"\b100\d{12}\b")
IBAN_RE = re.compile(r"\bAE\d{21}\b", re.I)


@dataclass
class CompanyMatchResult:
    matched: bool
    reason: str
    unassigned: bool


def match_company(
    text: str,
    filename: str,
    *,
    company_trn: str | None,
    company_iban: str | None,
    company_name: str | None,
) -> CompanyMatchResult:
    blob = f"{filename}\n{text or ''}"
    compact = blob.replace(" ", "").upper()

    if company_trn and company_trn in blob:
        return CompanyMatchResult(True, "trn", False)
    if company_iban:
        iban = company_iban.replace(" ", "").upper()
        if iban and iban in compact:
            return CompanyMatchResult(True, "iban", False)
    if company_name:
        tokens = [t for t in re.split(r"\W+", company_name) if len(t) >= 4]
        lower = blob.lower()
        if any(t.lower() in lower for t in tokens):
            return CompanyMatchResult(True, "name", False)

    # Document has some TRN/IBAN but none ours → mismatch; or nothing identifiable → unassigned
    has_other = bool(TRN_RE.search(blob) or IBAN_RE.search(blob))
    return CompanyMatchResult(
        False,
        "mismatch" if has_other else "no_identifiers",
        True,
    )
