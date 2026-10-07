from __future__ import annotations

import csv
import io

from daftar.errors import CodedError
from daftar.parsers.base import ParsedDocument, ParsedLine


class CardGenericParser:
    name = "card_generic"

    def can_parse(self, filename: str, mime: str, sample: bytes) -> int:
        name = filename.lower()
        # PDF card statements belong on the bank/card PDF path — never UTF-8-decode binary.
        if name.endswith(".pdf") or sample.startswith(b"%PDF") or "pdf" in (mime or "").lower():
            return 0
        head = sample.decode("utf-8", errors="ignore").lower()
        if "card" in name or "credit card" in head:
            return 80
        if "posting date" in head and "merchant" in head:
            return 75
        return 0

    def parse(self, filename: str, mime: str, content: bytes) -> ParsedDocument:
        if content.startswith(b"%PDF") or filename.lower().endswith(".pdf"):
            raise CodedError("card_pdf_not_csv")
        try:
            text = content.decode("utf-8-sig")
        except UnicodeError as exc:
            raise CodedError("card_decode_failed") from exc
        reader = csv.DictReader(io.StringIO(text))
        lines: list[ParsedLine] = []
        for row in reader:
            norm = {k.strip().lower(): v for k, v in row.items() if k}
            amount = _minor(norm.get("amount") or norm.get("aed"))
            if not amount:
                continue
            lines.append(
                ParsedLine(
                    description=str(norm.get("merchant") or norm.get("description") or ""),
                    amount_minor=abs(amount),
                    txn_date=str(norm.get("posting date") or norm.get("date") or "") or None,
                    debit=amount >= 0,
                    meta={"card": True},
                )
            )
        return ParsedDocument(
            doc_type="CARD_STATEMENT",
            party=None,
            document_date=lines[0].txn_date if lines else None,
            period_hint=lines[0].txn_date if lines else None,
            currency="AED",
            lines=lines,
            confidence=85,
        )


def _minor(raw: str | None) -> int:
    if not raw:
        return 0
    cleaned = str(raw).replace(",", "").strip()
    if not cleaned:
        return 0
    return int(round(float(cleaned) * 100))
