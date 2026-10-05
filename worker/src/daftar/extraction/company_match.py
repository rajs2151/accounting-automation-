"""Company match → Unassigned when TRN/IBAN/name do not match (Addendum A §4).

Name-only fuzzy hits are matched but need_review — never labelled as TRN match.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# UAE TRN: 15 digits starting with 1 (spaces/dashes stripped before match).
TRN_RE = re.compile(r"(?<!\d)1\d{14}(?!\d)")
IBAN_RE = re.compile(r"\bAE\d{21}\b", re.I)


@dataclass
class CompanyMatchResult:
    matched: bool
    reason: str  # trn | iban | name | mismatch | no_identifiers
    unassigned: bool
    needs_review: bool = False
    score: float | None = None
    label: str = ""


def _compact(value: str) -> str:
    return re.sub(r"[\s\-]", "", value or "")


def _name_score(blob: str, company_name: str | None) -> float:
    if not company_name or not company_name.strip():
        return 0.0
    tokens = [t for t in re.split(r"\W+", company_name) if len(t) >= 4]
    if not tokens:
        return 0.0
    lower = blob.lower()
    hits = sum(1 for t in tokens if t.lower() in lower)
    return hits / len(tokens)


def match_company(
    text: str,
    filename: str,
    *,
    company_trn: str | None,
    company_iban: str | None,
    company_name: str | None,
) -> CompanyMatchResult:
    blob = f"{filename}\n{text or ''}"
    compact = _compact(blob).upper()

    if company_trn:
        trn = _compact(company_trn)
        if trn and trn in _compact(blob):
            return CompanyMatchResult(
                True,
                "trn",
                False,
                needs_review=False,
                score=1.0,
                label=f"Matched — TRN exact ({company_trn})",
            )
    if company_iban:
        iban = company_iban.replace(" ", "").upper()
        if iban and iban in compact:
            return CompanyMatchResult(
                True,
                "iban",
                False,
                needs_review=False,
                score=1.0,
                label="Matched — IBAN exact",
            )

    score = _name_score(blob, company_name)
    if score >= 0.5:
        return CompanyMatchResult(
            True,
            "name",
            False,
            needs_review=True,
            score=score,
            label=f"Needs review — name fuzzy ({score * 100:.0f}%), not TRN",
        )

    has_other = bool(TRN_RE.search(_compact(blob)) or IBAN_RE.search(blob))
    return CompanyMatchResult(
        False,
        "mismatch" if has_other else "no_identifiers",
        True,
        needs_review=True,
        score=None,
        label=(
            "Unassigned — document TRN does not match company"
            if has_other
            else "Unassigned — no company identifiers"
        ),
    )
