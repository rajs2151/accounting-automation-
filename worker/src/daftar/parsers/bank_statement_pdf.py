"""UAE bank-statement PDF parser (text layer). Multi-IBAN → one account per IBAN.

An IBAN without its own printed opening/closing must NOT get invented 0/0
balances that would falsely pass a balance check.
"""

from __future__ import annotations

import re
from typing import Any

from daftar.extraction.fields import find_source, parse_amount_fils
from daftar.parsers.base import ParsedDocument, ParsedLine

IBAN_RE = re.compile(r"\b(AE\d{21})\b", re.I)
LINE_RE = re.compile(
    r"^(\d{1,2}/\d{1,2}/\d{4})\s+(.+?)\s+([\d,]+\.\d{2})\s+(CR|DR)\s*$",
    re.I,
)
OPENING_RE = re.compile(r"opening\s+balance\s*[:：]?\s*([\d,]+\.\d{2})", re.I)
CLOSING_RE = re.compile(r"closing\s+balance\s*[:：]?\s*([\d,]+\.\d{2})", re.I)
BANK_RE = re.compile(r"Bank\s*:\s*([^\n]+)", re.I)
PERIOD_RE = re.compile(
    r"Period\s*:\s*(\d{1,2}/\d{1,2}/\d{4})\s+to\s+(\d{1,2}/\d{1,2}/\d{4})",
    re.I,
)
CURRENCY_RE = re.compile(r"\b(AED|USD|EUR|GBP|SAR)\b", re.I)


def _pdf_pages(content: bytes) -> tuple[str, list[dict[str, Any]], list[tuple[int, str]]]:
    from daftar.extraction.pdf_words import collect_pdf_word_boxes

    word_boxes, page_texts, methods = collect_pdf_word_boxes(content)
    return "\n".join(page_texts), word_boxes, methods


def _iso_date(raw: str) -> str | None:
    parts = raw.strip().split("/")
    if len(parts) != 3:
        return None
    d, m, y = parts
    try:
        return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
    except ValueError:
        return None


def _minor(raw: str | None) -> int | None:
    if raw is None or str(raw).strip() == "":
        return None
    return parse_amount_fils(str(raw))


def _line_source(
    word_boxes: list[dict[str, Any]],
    *,
    date_raw: str,
    description: str,
    amount_raw: str,
) -> dict[str, Any] | None:
    """Locate the transaction line on the page; prefer full-line then amount."""
    if not word_boxes:
        return None
    for needle in (
        f"{date_raw} {description} {amount_raw}",
        f"{description} {amount_raw}",
        amount_raw,
        date_raw,
    ):
        src = find_source(word_boxes, needle)
        if src and src.get("page") is not None and src.get("bbox"):
            return src
    return None


def _parse_lines(
    text: str,
    opening: int | None,
    word_boxes: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    running = opening if opening is not None else None
    for raw in (text or "").splitlines():
        m = LINE_RE.match(raw.strip())
        if not m:
            continue
        amount = _minor(m.group(3))
        if amount is None:
            continue
        is_credit = m.group(4).upper() == "CR"
        debit = 0 if is_credit else amount
        credit = amount if is_credit else 0
        if running is not None:
            running = running + credit - debit
        date_raw = m.group(1)
        description = m.group(2).strip()
        source = _line_source(
            word_boxes or [],
            date_raw=date_raw,
            description=description,
            amount_raw=m.group(3),
        )
        lines.append(
            {
                "description": description,
                "amount_minor": amount,
                "debit": not is_credit,
                "txn_date": _iso_date(date_raw),
                "running_balance_minor": running,
                "source": source,
                "source_page": source.get("page") if source else None,
                "source_bbox": source.get("bbox") if source else None,
            }
        )
    return lines


def _slice_has_activity(slice_text: str) -> bool:
    if OPENING_RE.search(slice_text or "") or CLOSING_RE.search(slice_text or ""):
        return True
    return any(LINE_RE.match(raw.strip()) for raw in (slice_text or "").splitlines())


def _header_bits(text: str) -> dict[str, Any]:
    bank = BANK_RE.search(text)
    period = PERIOD_RE.search(text)
    currency = CURRENCY_RE.search(text)
    return {
        "bank_name": bank.group(1).strip() if bank else None,
        "period_from": _iso_date(period.group(1)) if period else None,
        "period_to": _iso_date(period.group(2)) if period else None,
        "currency": currency.group(1).upper() if currency else "AED",
    }


def _account(
    iban: str | None,
    *,
    bank_name: str | None,
    period_from: str | None,
    period_to: str | None,
    currency: str,
    opening_minor: int | None,
    closing_minor: int | None,
    lines: list[dict[str, Any]],
    balances_found: bool,
) -> dict[str, Any]:
    return {
        "iban": iban,
        "bank_name": bank_name,
        "period_from": period_from,
        "period_to": period_to,
        "opening_minor": opening_minor if balances_found else None,
        "closing_minor": closing_minor if balances_found else None,
        "lines": lines if balances_found or lines else [],
        "currency": currency,
        "balances_found": balances_found,
        # Back-compat alias used by extraction writer / older tests
        "has_own_activity_block": balances_found,
    }


def parse_bank_statement_text(
    text: str,
    word_boxes: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Split a statement PDF/text into one account dict per IBAN (or one if none)."""
    text = text or ""
    header = _header_bits(text)
    bank_name = header["bank_name"]
    period_from = header["period_from"]
    period_to = header["period_to"]
    currency = header["currency"]

    iban_matches = list(IBAN_RE.finditer(text))
    unique: list[str] = []
    first_index: dict[str, int] = {}
    for m in iban_matches:
        iban = m.group(1).upper()
        if iban not in first_index:
            first_index[iban] = m.start()
            unique.append(iban)

    opening_m = OPENING_RE.search(text)
    closing_m = CLOSING_RE.search(text)
    opening = _minor(opening_m.group(1)) if opening_m else None
    closing = _minor(closing_m.group(1)) if closing_m else None
    shared_lines = _parse_lines(text, opening, word_boxes)
    shared_balances_found = opening is not None and closing is not None

    if not unique:
        return [
            _account(
                None,
                bank_name=bank_name,
                period_from=period_from,
                period_to=period_to,
                currency=currency,
                opening_minor=opening,
                closing_minor=closing,
                lines=shared_lines,
                balances_found=shared_balances_found,
            )
        ]

    ordered = sorted(unique, key=lambda i: first_index[i])
    slices: dict[str, str] = {}
    for i, iban in enumerate(ordered):
        start = first_index[iban]
        end = first_index[ordered[i + 1]] if i + 1 < len(ordered) else len(text)
        slices[iban] = text[start:end]

    with_own = [iban for iban in unique if _slice_has_activity(slices.get(iban, ""))]
    per_iban = len(with_own) >= 2
    # Shared header block (both IBANs listed, then one activity block) → first IBAN owns it.
    shared_owner = unique[0] if (not per_iban and (shared_balances_found or shared_lines)) else None

    out: list[dict[str, Any]] = []
    for iban in unique:
        slice_text = slices.get(iban, "")
        if per_iban and iban in with_own:
            o_m = OPENING_RE.search(slice_text)
            c_m = CLOSING_RE.search(slice_text)
            o = _minor(o_m.group(1)) if o_m else None
            c = _minor(c_m.group(1)) if c_m else None
            balances_found = o is not None and c is not None
            out.append(
                _account(
                    iban,
                    bank_name=bank_name,
                    period_from=period_from,
                    period_to=period_to,
                    currency=currency,
                    opening_minor=o,
                    closing_minor=c,
                    lines=_parse_lines(slice_text, o, word_boxes),
                    balances_found=balances_found,
                )
            )
        elif iban == shared_owner:
            out.append(
                _account(
                    iban,
                    bank_name=bank_name,
                    period_from=period_from,
                    period_to=period_to,
                    currency=currency,
                    opening_minor=opening,
                    closing_minor=closing,
                    lines=shared_lines,
                    balances_found=shared_balances_found,
                )
            )
        else:
            out.append(
                _account(
                    iban,
                    bank_name=bank_name,
                    period_from=period_from,
                    period_to=period_to,
                    currency=currency,
                    opening_minor=None,
                    closing_minor=None,
                    lines=[],
                    balances_found=False,
                )
            )
    return out


def looks_like_bank_statement(text: str) -> bool:
    """Content-only heuristic (no filename)."""
    blob = text or ""
    lower = blob.lower()
    has_iban = IBAN_RE.search(blob) is not None
    has_opening = OPENING_RE.search(blob) is not None
    has_closing = CLOSING_RE.search(blob) is not None
    has_table = any(LINE_RE.match(raw.strip()) for raw in blob.splitlines())
    if "account statement" in lower and (has_iban or has_opening or has_table):
        return True
    if has_iban and (has_opening or has_closing) and has_table:
        return True
    if has_iban and has_opening and has_closing:
        return True
    return False


class BankStatementPdfParser:
    name = "bank_statement_pdf"

    def can_parse(self, filename: str, mime: str, sample: bytes) -> int:
        """Score by content only — never by filename.

        PDF text is often compressed in the stream, so raw-byte needles miss;
        open a short sample with PyMuPDF when the bytes look like a PDF.
        """
        text = sample.decode("utf-8", errors="ignore")
        if sample[:4] == b"%PDF":
            try:
                import fitz

                doc = fitz.open(stream=sample, filetype="pdf")
                try:
                    extracted = "\n".join((page.get_text("text") or "") for page in doc)
                    if extracted.strip():
                        text = extracted
                finally:
                    doc.close()
            except Exception:  # noqa: BLE001
                pass

        upper = text.upper().encode("utf-8", errors="ignore")
        if b"CREDIT STATEMENT" in upper or b"CREDIT CARD" in upper:
            return 0
        if b"BALANCE_HISTORY" in upper or (b"STRIPE" in upper and b"CSV" in upper):
            return 0
        if b"TAX INVOICE" in upper:
            return 0
        if looks_like_bank_statement(text):
            return 92
        if "ACCOUNT STATEMENT" in text.upper() and IBAN_RE.search(text):
            return 90
        if IBAN_RE.search(text) and (
            "OPENING BALANCE" in text.upper() or "CLOSING BALANCE" in text.upper()
        ):
            return 88
        if IBAN_RE.search(text) and (" CR" in text.upper() or " DR" in text.upper()):
            return 80
        return 0

    def parse(self, filename: str, mime: str, content: bytes) -> ParsedDocument:
        is_pdf = filename.lower().endswith(".pdf") or "pdf" in (mime or "").lower()
        word_boxes: list[dict[str, Any]] = []
        methods: list[tuple[int, str]] = []
        if is_pdf:
            text, word_boxes, methods = _pdf_pages(content)
        else:
            text = content.decode("utf-8", errors="ignore")

        accounts = parse_bank_statement_text(text, word_boxes)
        primary = next(
            (a for a in accounts if a.get("balances_found")),
            accounts[0] if accounts else {},
        )
        parsed_lines = [
            ParsedLine(
                description=str(ln.get("description") or ""),
                amount_minor=int(ln.get("amount_minor") or 0),
                currency=str(primary.get("currency") or "AED"),
                txn_date=ln.get("txn_date"),
                debit=bool(ln.get("debit")),
                confidence=95,
                meta={
                    "running_balance_minor": ln.get("running_balance_minor"),
                    "source": ln.get("source"),
                    "source_page": ln.get("source_page"),
                    "source_bbox": ln.get("source_bbox"),
                },
            )
            for ln in (primary.get("lines") or [])
        ]
        return ParsedDocument(
            doc_type="bank_statement",
            party=primary.get("bank_name"),
            document_date=primary.get("period_from"),
            period_hint=primary.get("period_from"),
            currency=str(primary.get("currency") or "AED"),
            lines=parsed_lines,
            confidence=92,
            ocr_used=False,
            source_account_hints=[a["iban"] for a in accounts if a.get("iban")],
            extras={
                "opening_minor": primary.get("opening_minor"),
                "closing_minor": primary.get("closing_minor"),
                "period_from": primary.get("period_from"),
                "period_to": primary.get("period_to"),
                "iban": primary.get("iban"),
                "accounts": accounts,
                "raw_text": text[:20000],
                "word_boxes": word_boxes,
                "page_methods": methods,
                "fields": {
                    "iban": {"value": primary.get("iban"), "status": "ok" if primary.get("iban") else "missing"},
                    "bank_name": {
                        "value": primary.get("bank_name"),
                        "status": "ok" if primary.get("bank_name") else "missing",
                    },
                    "period_from": {
                        "value": primary.get("period_from"),
                        "status": "ok" if primary.get("period_from") else "missing",
                    },
                    "period_to": {
                        "value": primary.get("period_to"),
                        "status": "ok" if primary.get("period_to") else "missing",
                    },
                    "opening_balance_minor": {
                        "value": primary.get("opening_minor"),
                        "status": "ok" if primary.get("opening_minor") is not None else "missing",
                    },
                    "closing_balance_minor": {
                        "value": primary.get("closing_minor"),
                        "status": "ok" if primary.get("closing_minor") is not None else "missing",
                    },
                },
            },
        )
