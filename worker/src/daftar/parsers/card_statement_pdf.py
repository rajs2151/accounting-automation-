"""Credit-card statement PDF: partial text-layer parse; never crash on binary PDF."""

from __future__ import annotations

import re
from typing import Any

from daftar.parsers.base import ParsedDocument, ParsedLine
from daftar.textnorm import arabic_indic_to_ascii

CARD_HINT = re.compile(
    r"(?i)\b(credit\s*card|card\s*statement|statement\s*period|minimum\s*payment|"
    r"credit\s*limit|total\s*due|previous\s*balance)\b"
)
AMOUNT_RE = re.compile(r"(-?[\d,]+\.\d{2})")
DATE_RE = re.compile(r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b")
LINE_RE = re.compile(
    r"^(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s+(.+?)\s+(-?[\d,]+\.\d{2})\s*$",
    re.I,
)
TOTAL_DUE_RE = re.compile(r"(?i)total\s*(amount\s*)?due\s*[:：]?\s*(-?[\d,]+\.\d{2})")
PERIOD_RE = re.compile(
    r"(?i)statement\s*period\s*[:：]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s*(?:to|-)\s*"
    r"(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})"
)


def _minor(raw: str | None) -> int | None:
    if raw is None or str(raw).strip() == "":
        return None
    from daftar.extraction.fields import parse_amount_fils

    try:
        return parse_amount_fils(str(raw))
    except Exception:  # noqa: BLE001
        return None


class CardStatementPdfParser:
    name = "card_statement_pdf"

    def can_parse(self, filename: str, mime: str, sample: bytes) -> int:
        name = (filename or "").lower()
        is_pdf = name.endswith(".pdf") or sample.startswith(b"%PDF") or "pdf" in (mime or "").lower()
        if not is_pdf:
            return 0
        # Peek text layer cheaply; binary-only PDFs still score low but non-zero so we own the path.
        try:
            import fitz

            doc = fitz.open(stream=sample[: min(len(sample), 2_000_000)], filetype="pdf")
            try:
                text = ""
                for page in doc:
                    text += page.get_text("text") or ""
                    if len(text) > 4000:
                        break
            finally:
                doc.close()
        except Exception:  # noqa: BLE001
            text = ""
        text = arabic_indic_to_ascii(text)
        if CARD_HINT.search(text) or "card" in name:
            return 70 if CARD_HINT.search(text) else 40
        return 0

    def parse(self, filename: str, mime: str, content: bytes) -> ParsedDocument:
        flags: list[str] = ["card_pdf_partial"]
        text = ""
        try:
            from daftar.extraction.pdf_words import collect_pdf_word_boxes

            _boxes, pages, _methods = collect_pdf_word_boxes(content)
            text = arabic_indic_to_ascii("\n".join(pages))
        except Exception as exc:  # noqa: BLE001
            flags.append(f"card_pdf_text_failed:{type(exc).__name__}")
            text = ""

        lines: list[ParsedLine] = []
        for raw in text.splitlines():
            s = raw.strip()
            if not s:
                continue
            m = LINE_RE.match(s)
            if not m:
                continue
            amount = _minor(m.group(3))
            if amount is None:
                continue
            lines.append(
                ParsedLine(
                    description=m.group(2).strip(),
                    amount_minor=abs(amount),
                    txn_date=_iso(m.group(1)),
                    debit=amount >= 0,
                    meta={"card": True},
                    confidence=70,
                )
            )

        period = PERIOD_RE.search(text)
        total_due = TOTAL_DUE_RE.search(text)
        extras: dict[str, Any] = {
            "raw_text": text[:20000],
            "flags": flags,
            "card": True,
        }
        if period:
            extras["period_from"] = _iso(period.group(1))
            extras["period_to"] = _iso(period.group(2))
        if total_due:
            extras["total_due_minor"] = _minor(total_due.group(2))
        if not lines:
            flags.append("card_pdf_no_lines")

        return ParsedDocument(
            doc_type="CARD_STATEMENT",
            party=None,
            document_date=lines[0].txn_date if lines else (extras.get("period_to") if period else None),
            period_hint=extras.get("period_to") if period else (lines[0].txn_date if lines else None),
            currency="AED",
            lines=lines,
            confidence=55 if lines else 35,
            ocr_used=False,
            extras=extras,
        )


def _iso(raw: str) -> str | None:
    parts = re.split(r"[/-]", (raw or "").strip())
    if len(parts) != 3:
        return None
    try:
        d, m, y = int(parts[0]), int(parts[1]), int(parts[2])
        if y < 100:
            y += 2000
        return f"{y:04d}-{m:02d}-{d:02d}"
    except ValueError:
        return None
