"""ING-4c: bank/card/XLSX parsing helpers (inline fixtures — no new PDFs)."""

from __future__ import annotations

from daftar.iban_check import is_valid_iban, normalize_iban
from daftar.parsers.bank_statement_pdf import _match_txn_line, parse_bank_statement_text
from daftar.parsers.card_generic import CardGenericParser
from daftar.parsers.card_statement_pdf import CardStatementPdfParser


def test_iban_mod97():
    # Well-known valid AE test IBAN used across fixtures.
    assert is_valid_iban("AE070331234567890123456")
    assert is_valid_iban("AE07 0331 2345 6789 0123 456")
    assert normalize_iban("ae07-0331 234567890123456") == "AE070331234567890123456"
    # Flip check digits → invalid.
    assert not is_valid_iban("AE990331234567890123456")


def test_skip_bcf_and_signed_amount_lines():
    assert _match_txn_line("Balance Brought Forward 1,000.00") is None
    assert _match_txn_line("B/F") is None
    assert _match_txn_line("Page Total 500.00") is None
    signed = _match_txn_line("01/05/2026 POS Purchase (50.00)")
    assert signed is not None
    assert signed["debit"] is True
    assert signed["debit_minor"] == 5000
    credit = _match_txn_line("02/05/2026 Refund 25.00")
    assert credit is not None
    assert credit["credit_minor"] == 2500


def test_iban_checksum_flag_and_multiline_desc():
    text = (
        "Bank: Test Bank\n"
        "IBAN AE990331234567890123456\n"  # invalid checksum — ignored
        "IBAN AE070331234567890123456\n"
        "Opening balance: 100.00\n"
        "Closing balance: 150.00\n"
        "01/05/2026 Transfer in 50.00 CR 150.00\n"
        "  extra detail line\n"
    )
    accounts = parse_bank_statement_text(text)
    assert len(accounts) == 1
    assert accounts[0]["iban"] == "AE070331234567890123456"
    flags = accounts[0].get("parse_flags") or []
    assert "iban_checksum_invalid" in flags
    assert accounts[0]["lines"]
    assert "extra detail line" in accounts[0]["lines"][0]["description"]


def test_wio_style_from_to_and_stacked_balances():
    text = (
        "ACCOUNT STATEMENT\n"
        "FROM 01/08/2026 TO 31/08/2026\n"
        "contact Wio Bank customer service\n"
        "IBAN AE070331234567890123456\n"
        "OPENING BALANCE\n"
        "0\n"
        "CLOSING BALANCE\n"
        "819\n"
        "01/08/2026 Interest 8.19 CR 819.00\n"
    )
    accounts = parse_bank_statement_text(text)
    assert len(accounts) == 1
    a = accounts[0]
    assert a["bank_name"] == "Wio Bank"
    assert a["period_from"] == "2026-08-01"
    assert a["period_to"] == "2026-08-31"
    assert a["opening_minor"] == 0
    assert a["closing_minor"] == 81900
    assert a["balances_found"] is True


def test_rak_style_statement_period_and_letterhead():
    text = (
        "Statement Period:\n"
        "01-Jan-2026 TO 30-Mar-2026\n"
        "The National Bank of Ras Al Khaimah (P.S.C)\n"
        "IBAN AE070331234567890123456\n"
        "Opening Balance\n"
        "AED\n"
        "1,000.00 Cr.\n"
        "Closing Balance\n"
        "AED\n"
        "1,250.50 Cr.\n"
    )
    accounts = parse_bank_statement_text(text)
    assert len(accounts) == 1
    a = accounts[0]
    assert a["bank_name"] == "RAK Bank"
    assert a["period_from"] == "2026-01-01"
    assert a["period_to"] == "2026-03-30"
    assert a["opening_minor"] == 100000
    assert a["closing_minor"] == 125050


def test_card_pdf_parser_never_crashes_and_flags_partial():
    pdf = b"%PDF-1.4\n" + b"\xff\xfe binary card " + b"\x00" * 64
    parser = CardStatementPdfParser()
    # Even without text layer, can_parse may be 0; parse must still be safe if called.
    try:
        import fitz

        # Build a tiny text PDF with card keywords via pymupdf.
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text(
            (50, 72),
            "CREDIT CARD STATEMENT\nStatement Period: 01/01/2026 to 31/01/2026\n"
            "01/01/2026 MERCHANT ABC 12.50\nTotal Due: 12.50\n",
        )
        content = doc.tobytes()
        doc.close()
    except Exception:  # noqa: BLE001
        content = pdf

    score = parser.can_parse("enbd_card.pdf", "application/pdf", content)
    assert score > 0
    doc = parser.parse("enbd_card.pdf", "application/pdf", content)
    assert doc.doc_type == "CARD_STATEMENT"
    assert "card_pdf_partial" in (doc.extras or {}).get("flags", [])
    # CSV card parser still refuses PDFs.
    assert CardGenericParser().can_parse("card.pdf", "application/pdf", content) == 0
