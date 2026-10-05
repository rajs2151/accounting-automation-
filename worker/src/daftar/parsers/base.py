"""Pluggable document parsers (Addendum A / Phase 1).

OCR policy: text-layer PDFs via pdfplumber/PyMuPDF; scans via local docTR with
EasyOCR fallback for Arabic/low confidence. Every OCR field must be marked
low-confidence. No external OCR/LLM APIs until security PASS.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class ParsedLine:
    description: str
    amount_minor: int
    currency: str = "AED"
    txn_date: str | None = None
    reference: str | None = None
    debit: bool = True
    confidence: int = 100
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class ParsedDocument:
    doc_type: str
    party: str | None
    document_date: str | None
    period_hint: str | None
    currency: str
    lines: list[ParsedLine]
    confidence: int
    ocr_used: bool = False
    source_account_hints: list[str] = field(default_factory=list)
    extras: dict[str, Any] = field(default_factory=dict)


class DocumentParser(Protocol):
    name: str

    def can_parse(self, filename: str, mime: str, sample: bytes) -> int:
        """Return 0–100 confidence that this parser should handle the file."""

    def parse(self, filename: str, mime: str, content: bytes) -> ParsedDocument:
        ...


def register_builtin_parsers() -> list[DocumentParser]:
    from daftar.parsers.invoice_generic import InvoiceGenericParser
    from daftar.parsers.bank_uae_a import BankUaeAParser
    from daftar.parsers.bank_uae_b import BankUaeBParser
    from daftar.parsers.bank_statement_pdf import BankStatementPdfParser
    from daftar.parsers.card_generic import CardGenericParser
    from daftar.parsers.stripe_balance_history import StripeBalanceHistoryParser
    from daftar.parsers.gateway_pdf_generic import GatewayPdfGenericParser

    return [
        StripeBalanceHistoryParser(),
        BankStatementPdfParser(),
        BankUaeAParser(),
        BankUaeBParser(),
        CardGenericParser(),
        GatewayPdfGenericParser(),
        InvoiceGenericParser(),
    ]


def pick_parser(filename: str, mime: str, content: bytes, parsers: list[DocumentParser] | None = None):
    parsers = parsers or register_builtin_parsers()
    # PDFs often compress text streams; give can_parse enough bytes to open.
    sample = content if len(content) <= 256_000 else content[:256_000]
    ranked = sorted(
        ((p.can_parse(filename, mime, sample), p) for p in parsers),
        key=lambda item: item[0],
        reverse=True,
    )
    if not ranked or ranked[0][0] <= 0:
        return None, 0
    return ranked[0][1], ranked[0][0]
