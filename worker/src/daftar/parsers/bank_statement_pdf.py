"""UAE bank-statement PDF parser (text layer). Multi-IBAN → one account per IBAN.

An IBAN without its own printed opening/closing must NOT get invented 0/0
balances that would falsely pass a balance check.

Running balances are only stored when the statement prints a balance column;
they are never computed and presented as printed.
"""

from __future__ import annotations

import re
from typing import Any

from daftar.extraction.fields import find_source, parse_amount_fils
from daftar.parsers.base import ParsedDocument, ParsedLine

IBAN_RE = re.compile(r"\b(AE\d{21})\b", re.I)
# date + desc + amount + CR/DR [+ optional printed balance]
LINE_CRDR_RE = re.compile(
    r"^(\d{1,2}/\d{1,2}/\d{4})\s+(.+?)\s+([\d,]+\.\d{2})\s+(CR|DR)"
    r"(?:\s+([\d,]+\.\d{2}))?\s*$",
    re.I,
)
# date + desc + debit + credit [+ optional printed balance] (no CR/DR suffix)
LINE_DC_RE = re.compile(
    r"^(\d{1,2}/\d{1,2}/\d{4})\s+(.+?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})"
    r"(?:\s+([\d,]+\.\d{2}))?\s*$",
    re.I,
)
# date + desc + signed single amount [+ optional balance]
LINE_SIGNED_RE = re.compile(
    r"^(\d{1,2}/\d{1,2}/\d{4})\s+(.+?)\s+(\(?-?[\d,]+\.\d{2}\)?)"
    r"(?:\s+([\d,]+\.\d{2}))?\s*$",
    re.I,
)
# Same-line balances (legacy fixtures): "Opening balance: 100.00"
OPENING_RE = re.compile(
    r"opening\s+balance\s*[:：]?\s*([\d,]+\.\d{2}|\d+)\b",
    re.I,
)
CLOSING_RE = re.compile(
    r"closing\s+balance\s*[:：]?\s*([\d,]+\.\d{2}|\d+)\b",
    re.I,
)
# Stacked Wio / RAK: label then amount on a following line (optional AED / Cr.).
BALANCE_AMOUNT_RE = re.compile(
    r"^\s*(?:AED\s*)?([\d,]+\.\d{2}|\d+)\s*(?:Cr\.?|Dr\.?)?\s*",
    re.I,
)
BANK_RE = re.compile(r"(?:Bank\s*(?:Name)?\s*[:：]\s*|Bank\s*:\s*)([^\n]+)", re.I)
BANK_LETTERHEAD_RE = re.compile(
    r"\b(Wio\s+Bank|RAKBANK|Rak\s*Bank|"
    r"The\s+National\s+Bank\s+of\s+Ras\s+Al\s+Khaimah|"
    r"Emirates\s+NBD|ENBD|FAB|First\s+Abu\s+Dhabi\s+Bank|"
    r"Mashreq|ADCB|HSBC)\b",
    re.I,
)
# Period: "Period: d/m/y to d/m/y" | "FROM … TO …" | "Statement Period: … TO …"
_DATE_TOKEN = (
    r"\d{1,2}/\d{1,2}/\d{4}"
    r"|\d{1,2}-\d{1,2}-\d{4}"
    r"|\d{1,2}[- ][A-Za-z]{3,9}[- ]\d{4}"
)
PERIOD_RE = re.compile(
    rf"(?:Statement\s+Period|Period)\s*[:：]?\s*({_DATE_TOKEN})\s+to\s+({_DATE_TOKEN})"
    rf"|FROM\s+({_DATE_TOKEN})\s+TO\s+({_DATE_TOKEN})",
    re.I,
)
CURRENCY_RE = re.compile(r"\b(AED|USD|EUR|GBP|SAR)\b", re.I)
# Dated line start — used to flag rows that look like transactions but match no pattern.
DATE_LINE_RE = re.compile(r"^(\d{1,2}/\d{1,2}/\d{4})\b")
# Noise rows: brought/carried forward, page totals, repeated column headers.
SKIP_LINE_RE = re.compile(
    r"(?i)^\s*("
    r"B/?C/?F|B/?F|C/?F|"
    r"balance\s+brought\s+forward|balance\s+carried\s+forward|"
    r"brought\s+forward|carried\s+forward|"
    r"page\s+total|total\s+for\s+page|sub\s*total|"
    r"date\s+description\s+(debit|credit|amount)|"
    r"txn\s*date|transaction\s+date"
    r")\b"
)


def _pdf_pages(content: bytes) -> tuple[str, list[dict[str, Any]], list[tuple[int, str]]]:
    from daftar.extraction.pdf_words import collect_pdf_word_boxes

    word_boxes, page_texts, methods = collect_pdf_word_boxes(content)
    return "\n".join(page_texts), word_boxes, methods


def _iso_date(raw: str) -> str | None:
    from daftar.extraction.fields import parse_invoice_date

    iso, _, _ = parse_invoice_date((raw or "").strip())
    if iso:
        return iso
    # dd-mm-yyyy fallback
    parts = re.split(r"[/\-.]", (raw or "").strip())
    if len(parts) != 3:
        return None
    try:
        d, m, y = int(parts[0]), int(parts[1]), int(parts[2])
        if y < 100:
            y += 2000
        return f"{y:04d}-{m:02d}-{d:02d}"
    except ValueError:
        return None


def _minor(raw: str | None) -> int | None:
    if raw is None or str(raw).strip() == "":
        return None
    return parse_amount_fils(str(raw))


def _balance_after_label(text: str, label: str) -> int | None:
    """Find opening/closing when amount is on the same or following lines."""
    same = OPENING_RE if label == "opening" else CLOSING_RE
    m = same.search(text or "")
    if m:
        return _minor(m.group(1))
    word = "opening" if label == "opening" else "closing"
    # Window search: label then amount within ~120 chars (RAK bilingual lines).
    win = re.search(
        rf"(?is){word}\s+balance\b.{{0,120}}?(?:AED|USD|EUR|GBP|SAR)?\s*"
        rf"([\d,]+\.\d{{2}}|\d+)\s*(?:Cr\.?|Dr\.?)?",
        text or "",
    )
    if win:
        return _minor(win.group(1))
    # Stacked: LABEL\n[AED]\n123.45 [Cr.]
    pat = re.compile(rf"(?im)^(?:{word}\s+balance)\b.*$")
    lines = (text or "").splitlines()
    for i, line in enumerate(lines):
        if not pat.match(line.strip()):
            continue
        # Amount may share the label line after bilingual glue
        am_same = BALANCE_AMOUNT_RE.search(line)
        if am_same and not re.search(rf"(?i){word}\s+balance\s*$", line.strip()):
            # Only if digits appear after the label token
            after = re.split(rf"(?i){word}\s+balance", line, maxsplit=1)
            if len(after) > 1 and re.search(r"\d", after[1]):
                return _minor(am_same.group(1))
        for nxt in lines[i + 1 : i + 6]:
            am = BALANCE_AMOUNT_RE.search(nxt)
            if am:
                return _minor(am.group(1))
            # Skip pure currency / Arabic gloss lines
            if re.match(r"(?i)^\s*(AED|USD|EUR|GBP|SAR)?\s*$", nxt):
                continue
            if nxt.strip() and not re.search(r"[\d]", nxt):
                continue
            if nxt.strip():
                break
    return None


def _period_bits(text: str) -> tuple[str | None, str | None]:
    m = PERIOD_RE.search(text or "")
    if not m:
        return None, None
    if m.group(1) and m.group(2):
        return _iso_date(m.group(1)), _iso_date(m.group(2))
    return _iso_date(m.group(3)), _iso_date(m.group(4))


def _bank_name_bits(text: str) -> str | None:
    bank = BANK_RE.search(text or "")
    if bank:
        name = bank.group(1).strip()
        # "Bank Name : RAK Bank" style — take after colon already in group
        if name and len(name) < 80:
            return re.sub(r"\s+", " ", name)
    letter = BANK_LETTERHEAD_RE.search(text or "")
    if letter:
        raw = letter.group(1)
        # Normalize common letterheads
        key = raw.casefold()
        if "wio" in key:
            return "Wio Bank"
        if "ras al khaimah" in key or "rak" in key:
            return "RAK Bank"
        return re.sub(r"\s+", " ", raw.strip())
    return None


def _match_txn_line(raw: str) -> dict[str, Any] | None:
    """Parse one transaction line; support CR/DR and debit/credit columns + optional balance."""
    from daftar.textnorm import arabic_indic_to_ascii

    s = arabic_indic_to_ascii(raw or "").strip()
    if not s or SKIP_LINE_RE.match(s):
        return None
    m = LINE_CRDR_RE.match(s)
    if m:
        amount = _minor(m.group(3))
        if amount is None:
            return None
        is_credit = m.group(4).upper() == "CR"
        printed_bal = _minor(m.group(5)) if m.group(5) else None
        return {
            "date_raw": m.group(1),
            "description": m.group(2).strip(),
            "amount_raw": m.group(3),
            "amount_minor": amount,
            "debit": not is_credit,
            "debit_minor": 0 if is_credit else amount,
            "credit_minor": amount if is_credit else 0,
            "running_balance_minor": printed_bal,
        }
    m = LINE_DC_RE.match(s)
    if m:
        debit = _minor(m.group(3))
        credit = _minor(m.group(4))
        if debit is None or credit is None:
            return None
        # Require a real movement so header-like rows are not swallowed.
        if debit == 0 and credit == 0:
            return None
        # Both columns non-zero is ambiguous (often amount + printed balance).
        if debit != 0 and credit != 0:
            return {
                "ambiguous_columns": True,
                "date_raw": m.group(1),
                "description": m.group(2).strip(),
            }
        printed_bal = _minor(m.group(5)) if m.group(5) else None
        amount = credit if credit else debit
        return {
            "date_raw": m.group(1),
            "description": m.group(2).strip(),
            "amount_raw": m.group(4) if credit else m.group(3),
            "amount_minor": amount,
            "debit": credit == 0,
            "debit_minor": debit,
            "credit_minor": credit,
            "running_balance_minor": printed_bal,
        }
    m = LINE_SIGNED_RE.match(s)
    if m:
        # Avoid treating CR/DR lines twice — already handled above.
        desc = m.group(2).strip()
        if re.search(r"\b(CR|DR)\b", desc, re.I):
            return None
        amount = _minor(m.group(3))
        if amount is None or amount == 0:
            return None
        printed_bal = _minor(m.group(4)) if m.group(4) else None
        is_debit = amount < 0 or str(m.group(3)).strip().startswith("(")
        abs_amt = abs(amount)
        return {
            "date_raw": m.group(1),
            "description": desc,
            "amount_raw": m.group(3),
            "amount_minor": abs_amt,
            "debit": is_debit,
            "debit_minor": abs_amt if is_debit else 0,
            "credit_minor": 0 if is_debit else abs_amt,
            "running_balance_minor": printed_bal,
        }
    return None


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
    word_boxes: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Extract transaction lines + parse warnings. Printed balance is read, never computed."""
    from daftar.textnorm import arabic_indic_to_ascii

    lines: list[dict[str, Any]] = []
    parse_flags: list[str] = []
    pending_desc: str | None = None
    for line_no, raw in enumerate((text or "").splitlines(), start=1):
        s = arabic_indic_to_ascii(raw or "").strip()
        if not s:
            continue
        if SKIP_LINE_RE.match(s):
            continue
        matched = _match_txn_line(s)
        if matched and matched.get("ambiguous_columns"):
            parse_flags.append(f"ambiguous_line_columns:{line_no}")
            continue
        if not matched:
            # Continuation description (no date) attaches to the previous txn —
            # but never swallow opening/closing/balance summary or headers.
            is_meta = bool(
                OPENING_RE.search(s)
                or CLOSING_RE.search(s)
                or SKIP_LINE_RE.match(s)
                or re.match(r"(?i)^(bank|iban|period|currency|account)\b", s)
            )
            if (
                pending_desc is not None
                and lines
                and not DATE_LINE_RE.match(s)
                and not is_meta
            ):
                lines[-1]["description"] = (lines[-1]["description"] + " " + s).strip()
                continue
            # Dated but unmatched → never silently drop.
            if DATE_LINE_RE.match(s):
                parse_flags.append(f"unparsed_line:{line_no}")
            continue
        date_raw = matched["date_raw"]
        description = matched["description"]
        source = _line_source(
            word_boxes or [],
            date_raw=date_raw,
            description=description,
            amount_raw=matched["amount_raw"],
        )
        lines.append(
            {
                "description": description,
                "amount_minor": matched["amount_minor"],
                "debit": matched["debit"],
                "debit_minor": matched["debit_minor"],
                "credit_minor": matched["credit_minor"],
                "txn_date": _iso_date(date_raw),
                "running_balance_minor": matched["running_balance_minor"],
                "source": source,
                "source_page": source.get("page") if source else None,
                "source_bbox": source.get("bbox") if source else None,
            }
        )
        pending_desc = description
    return lines, parse_flags


def _slice_has_activity(slice_text: str) -> bool:
    if (
        _balance_after_label(slice_text, "opening") is not None
        or _balance_after_label(slice_text, "closing") is not None
    ):
        return True
    return any(_match_txn_line(raw) for raw in (slice_text or "").splitlines())


def _header_bits(text: str) -> dict[str, Any]:
    period_from, period_to = _period_bits(text)
    currency = CURRENCY_RE.search(text)
    return {
        "bank_name": _bank_name_bits(text),
        "period_from": period_from,
        "period_to": period_to,
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
    account_attribution_ambiguous: bool = False,
    parse_flags: list[str] | None = None,
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
        "account_attribution_ambiguous": account_attribution_ambiguous,
        "parse_flags": list(parse_flags or []),
    }


def parse_bank_statement_text(
    text: str,
    word_boxes: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Split a statement PDF/text into one account dict per IBAN (or one if none)."""
    from daftar.iban_check import is_valid_iban
    from daftar.textnorm import arabic_indic_to_ascii

    text = arabic_indic_to_ascii(text or "")
    header = _header_bits(text)
    bank_name = header["bank_name"]
    period_from = header["period_from"]
    period_to = header["period_to"]
    currency = header["currency"]

    iban_matches = list(IBAN_RE.finditer(text))
    unique: list[str] = []
    first_index: dict[str, int] = {}
    first_end: dict[str, int] = {}
    iban_flags: list[str] = []
    for m in iban_matches:
        iban = m.group(1).upper()
        if not is_valid_iban(iban):
            if "iban_checksum_invalid" not in iban_flags:
                iban_flags.append("iban_checksum_invalid")
            continue
        if iban not in first_index:
            first_index[iban] = m.start()
            first_end[iban] = m.end()
            unique.append(iban)

    opening = _balance_after_label(text, "opening")
    closing = _balance_after_label(text, "closing")
    shared_lines, shared_flags = _parse_lines(text, word_boxes)
    shared_flags = list(dict.fromkeys([*iban_flags, *shared_flags]))
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
                parse_flags=shared_flags,
            )
        ]

    ordered = sorted(unique, key=lambda i: first_index[i])
    # Section = text AFTER this IBAN and BEFORE the next IBAN (position rule).
    sections: dict[str, str] = {}
    for i, iban in enumerate(ordered):
        start = first_end[iban]
        end = first_index[ordered[i + 1]] if i + 1 < len(ordered) else len(text)
        sections[iban] = text[start:end]

    with_own = [iban for iban in ordered if _slice_has_activity(sections.get(iban, ""))]
    per_iban = len(with_own) >= 2

    # Shared / ambiguous activity across multiple IBANs: attribute by position.
    # Single-IBAN statements always own their (only) activity block.
    shared_owner: str | None = None
    ambiguous = False
    if len(unique) == 1:
        shared_owner = unique[0]
    elif not per_iban and (shared_balances_found or shared_lines or with_own):
        ambiguous = True
        if with_own:
            shared_owner = with_own[0]  # first section (by IBAN order) that contains activity
        else:
            shared_owner = unique[0]  # no section contains it → first-listed

    out: list[dict[str, Any]] = []
    for iban in unique:
        section = sections.get(iban, "")
        if per_iban and iban in with_own:
            o = _balance_after_label(section, "opening")
            c = _balance_after_label(section, "closing")
            balances_found = o is not None and c is not None
            sec_lines, sec_flags = _parse_lines(section, word_boxes)
            out.append(
                _account(
                    iban,
                    bank_name=bank_name,
                    period_from=period_from,
                    period_to=period_to,
                    currency=currency,
                    opening_minor=o,
                    closing_minor=c,
                    lines=sec_lines,
                    balances_found=balances_found,
                    parse_flags=list(dict.fromkeys([*iban_flags, *sec_flags])),
                )
            )
        elif iban == shared_owner:
            # Prefer balances/lines from the owning section; fall back to whole-doc.
            o = _balance_after_label(section, "opening")
            c = _balance_after_label(section, "closing")
            if o is None:
                o = opening
            if c is None:
                c = closing
            sec_lines, sec_flags = _parse_lines(section, word_boxes)
            # Single-IBAN: whole-doc lines so parse_flags use document line numbers.
            if len(unique) == 1:
                lines, acct_flags = shared_lines, shared_flags
            elif sec_lines:
                lines, acct_flags = sec_lines, sec_flags
            else:
                lines, acct_flags = shared_lines, shared_flags
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
                    lines=lines,
                    balances_found=balances_found,
                    account_attribution_ambiguous=ambiguous,
                    parse_flags=acct_flags,
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
    has_table = any(_match_txn_line(raw) for raw in blob.splitlines())
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
                    "debit_minor": ln.get("debit_minor"),
                    "credit_minor": ln.get("credit_minor"),
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
