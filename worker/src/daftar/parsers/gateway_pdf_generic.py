from __future__ import annotations

import re
from daftar.parsers.base import ParsedDocument, ParsedLine


class GatewayPdfGenericParser:
    """Gateway settlement PDFs (Nomod / Network-style).

    Prefer text-layer / OCR via extract_file (same path as invoices). Latin-1
    binary scrape is a last resort for empty scans when OCR is unavailable.
    """

    name = "gateway_pdf_generic"

    def can_parse(self, filename: str, mime: str, sample: bytes) -> int:
        name = filename.lower()
        if "nomod" in name or "network" in name or "gateway" in name:
            return 70
        if mime == "application/pdf" and (b"SETTLEMENT" in sample.upper() or b"PAYOUT" in sample.upper()):
            return 55
        return 0

    def parse(self, filename: str, mime: str, content: bytes) -> ParsedDocument:
        text = ""
        ocr_used = False
        period_hint = None
        try:
            from daftar.extract import extract_file

            extraction = extract_file(content, "pdf")
            pages = list(getattr(extraction, "raw_pages", []) or [])
            text = "\n".join(pages)
            methods = list(extraction.methods or [])
            ocr_used = any(m != "pdf_text" for _, m in methods)
        except Exception:
            text = ""

        if not (text or "").strip():
            text = content.decode("latin-1", errors="ignore")
            ocr_used = False

        # Period if printed (FROM…TO… / Statement Period)
        from daftar.parsers.bank_statement_pdf import _period_bits

        period_from, period_to = _period_bits(text)
        if period_from and period_to:
            period_hint = f"{period_from}:{period_to}"

        amounts = [
            int(round(float(x.replace(",", "")) * 100))
            for x in re.findall(r"([0-9,]+\.\d{2})", text)
        ]
        # Cap confidence when we only have binary scrape / empty OCR
        conf = 70 if ocr_used and amounts else (55 if amounts else 25)
        lines = [
            ParsedLine(
                description=f"gateway payout line {idx + 1}",
                amount_minor=amt,
                debit=False,
                confidence=conf,
                meta={"gateway": "generic"},
            )
            for idx, amt in enumerate(amounts[:50])
        ]
        return ParsedDocument(
            doc_type="GATEWAY_PDF",
            party=None,
            document_date=None,
            period_hint=period_hint,
            currency="AED",
            lines=lines or [ParsedLine(description=filename, amount_minor=0, confidence=20)],
            confidence=conf,
            ocr_used=ocr_used,
            extras={
                "period_from": period_from,
                "period_to": period_to,
                "flags": [] if amounts else ["gateway_empty_or_unparsed"],
            },
        )
