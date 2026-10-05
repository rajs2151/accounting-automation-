"""E2: bank statement PDF → books_statement_extractions + lines (multi-IBAN, balance gate)."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from daftar.extraction import process_extract_document
from daftar.extraction.classify import classify_document
from daftar.extraction.dedupe import sha256_hex
from daftar.extraction.pdf_words import collect_pdf_word_boxes
from daftar.parsers.bank_statement_pdf import (
    BankStatementPdfParser,
    parse_bank_statement_text,
)
from daftar.parsers.base import pick_parser
from tests.conftest import OMAR

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "extraction"
PDFS = FIXTURES / "pdfs"
GT = FIXTURES / "ground_truth"
TEXT = FIXTURES / "text"

DESERT_CLIENT_ID = "e1000001-0000-4000-8000-000000000001"

# Hand values from fixtures/extraction/text (ground_truth only stores doc_type/route).
BANK_A_EXPECTED = {
    "iban": "AE070331234567890123456",
    "bank_name": "Synthetic UAE Bank A",
    "period_from": "2026-05-01",
    "period_to": "2026-05-31",
    "opening_minor": 100_000,
    "closing_minor": 130_000,
    "lines": [
        {"txn_date": "2026-05-05", "description": "CLIENT RECEIPT", "debit": False, "amount_minor": 50_000},
        {"txn_date": "2026-05-10", "description": "OFFICE RENT", "debit": True, "amount_minor": 20_000},
    ],
}
BANK_B_EXPECTED = {
    "iban": "AE070331234567890123456",
    "bank_name": "Synthetic UAE Bank B",
    "period_from": "2026-05-01",
    "period_to": "2026-05-31",
    "opening_minor": 200_000,
    "closing_minor": 210_000,
    "lines": [
        {"txn_date": "2026-05-05", "description": "RECEIPT", "debit": False, "amount_minor": 10_000},
    ],
}


def _gt(stem: str) -> dict:
    return json.loads((GT / f"{stem}.json").read_text(encoding="utf-8"))


def _assert_account_matches(acct: dict, expected: dict) -> None:
    assert acct["iban"] == expected["iban"]
    assert acct["bank_name"] == expected["bank_name"]
    assert acct["period_from"] == expected["period_from"]
    assert acct["period_to"] == expected["period_to"]
    assert acct["opening_minor"] == expected["opening_minor"]
    assert acct["closing_minor"] == expected["closing_minor"]
    assert len(acct["lines"]) == len(expected["lines"])
    for got, exp in zip(acct["lines"], expected["lines"], strict=True):
        assert got["txn_date"] == exp["txn_date"]
        assert got["description"] == exp["description"]
        assert got["debit"] is exp["debit"]
        assert got["amount_minor"] == exp["amount_minor"]


def _balance_ok(opening: int, closing: int, lines: list[dict]) -> bool:
    running = opening
    for ln in lines:
        debit = ln["amount_minor"] if ln["debit"] else 0
        credit = 0 if ln["debit"] else ln["amount_minor"]
        running = running + credit - debit
    return running == closing


@pytest.mark.parametrize(
    "stem,expected",
    [("bank_a", BANK_A_EXPECTED), ("bank_b_bilingual", BANK_B_EXPECTED)],
)
def test_bank_ab_header_and_lines_match(stem: str, expected: dict):
    gt = _gt(stem)
    assert gt["doc_type"] == "bank_statement"

    text = (TEXT / f"{stem}.txt").read_text(encoding="utf-8")
    accounts = parse_bank_statement_text(text)
    assert len(accounts) == 1
    _assert_account_matches(accounts[0], expected)
    assert _balance_ok(expected["opening_minor"], expected["closing_minor"], accounts[0]["lines"])

    # Content classification (filename stripped of bank cues)
    cls = classify_document("upload.pdf", text)
    assert cls.doc_type == gt["doc_type"]
    assert cls.confidence >= 0.55

    pdf = PDFS / f"{stem}.pdf"
    if not pdf.exists():
        pytest.skip(f"{stem}.pdf missing")
    parsed = BankStatementPdfParser().parse(f"{stem}.pdf", "application/pdf", pdf.read_bytes())
    assert parsed.doc_type == "bank_statement"
    assert parsed.extras.get("opening_minor") == expected["opening_minor"]
    assert parsed.extras.get("closing_minor") == expected["closing_minor"]
    assert len(parsed.lines) == len(expected["lines"])
    for ln in parsed.lines:
        src = (ln.meta or {}).get("source") or {}
        assert src.get("page") is not None, ln.description
        assert src.get("bbox") is not None and len(src["bbox"]) == 4, ln.description


def test_bank_c_multi_iban_no_invented_balances():
    gt = _gt("bank_c_multi_iban")
    assert gt["doc_type"] == "bank_statement"

    text = (TEXT / "bank_c_multi_iban.txt").read_text(encoding="utf-8")
    accounts = parse_bank_statement_text(text)
    assert len(accounts) == 2
    assert accounts[0]["iban"] == "AE070331234567890123456"
    assert accounts[1]["iban"] == "AE460090000000123456789"

    # First IBAN owns the shared printed activity block
    assert accounts[0]["balances_found"] is True
    assert accounts[0]["opening_minor"] == 50_000
    assert accounts[0]["closing_minor"] == 75_000
    assert len(accounts[0]["lines"]) == 1
    assert accounts[0]["lines"][0]["description"] == "TRANSFER IN"
    assert accounts[0]["lines"][0]["amount_minor"] == 25_000
    assert _balance_ok(50_000, 75_000, accounts[0]["lines"])

    # Second IBAN: no printed balances → never invent 0/0
    assert accounts[1]["balances_found"] is False
    assert accounts[1]["opening_minor"] is None
    assert accounts[1]["closing_minor"] is None
    assert accounts[1]["lines"] == []

    cls = classify_document("upload.pdf", text)
    assert cls.doc_type == gt["doc_type"]


def test_pick_parser_content_not_filename():
    path = PDFS / "bank_a.pdf"
    if not path.exists():
        pytest.skip("bank_a.pdf missing")
    content = path.read_bytes()
    # Filename has no bank cue
    parser, conf = pick_parser("upload.pdf", "application/pdf", content)
    assert parser is not None
    assert parser.name == "bank_statement_pdf"
    assert conf >= 70


def test_tampered_line_needs_review_with_difference(ctx):
    """One line amount changed → needs_review with balance_diff equal to the mismatch."""
    conn, storage = ctx
    text = (TEXT / "bank_a.txt").read_text(encoding="utf-8")
    # +1.00 AED = +100 fils on the credit line
    tampered = text.replace("500.00 CR", "501.00 CR")
    content = tampered.encode("utf-8")

    accounts = parse_bank_statement_text(tampered)
    assert accounts[0]["opening_minor"] == 100_000
    assert accounts[0]["closing_minor"] == 130_000
    assert accounts[0]["lines"][0]["amount_minor"] == 50_100
    # opening 100000 + 50100 - 20000 = 130100; printed closing 130000 → diff +100
    from daftar.extraction import _balance_diff, _stmt_line_dict

    lines = [_stmt_line_dict(ln) for ln in accounts[0]["lines"]]
    diff = _balance_diff(100_000, 130_000, lines)
    assert diff == 100

    digest = sha256_hex(content)
    file_id = str(uuid4())
    inbox_id = str(uuid4())
    storage_key = f"test/e2-tamper/{file_id}.txt"
    storage.put(storage_key, content, "text/plain")
    conn.execute(
        """
        INSERT INTO books_files (
          id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            file_id,
            DESERT_CLIENT_ID,
            digest,
            storage_key,
            "upload.txt",
            "text/plain",
            len(content),
            OMAR,
        ),
    )
    conn.execute(
        """
        INSERT INTO books_inbox_items (id, client_id, file_id, status)
        VALUES (%s, %s, %s, 'queued')
        """,
        (inbox_id, DESERT_CLIENT_ID, file_id),
    )
    conn.commit()

    process_extract_document(conn, storage, {"inboxItemId": inbox_id, "fileId": file_id})
    conn.commit()

    row = conn.execute(
        """
        SELECT status, validation_flags, opening_balance_minor, closing_balance_minor
        FROM books_statement_extractions WHERE inbox_item_id = %s
        """,
        (inbox_id,),
    ).fetchone()
    assert row is not None
    assert row["status"] == "needs_review"
    assert row["opening_balance_minor"] == 100_000
    assert row["closing_balance_minor"] == 130_000
    flags_val = row["validation_flags"]
    if isinstance(flags_val, str):
        flags_val = json.loads(flags_val)
    assert "closing_mismatch" in flags_val
    assert f"balance_diff:{diff}" in flags_val
    assert "balance_ok" not in flags_val


def test_process_extract_bank_a_and_c(ctx):
    """Full pipeline: bank_a ready+balance_ok; bank_c two stmts, second balances_not_found."""
    conn, storage = ctx

    def _run(stem: str) -> str:
        path = PDFS / f"{stem}.pdf"
        if not path.exists():
            pytest.skip(f"{stem}.pdf missing")
        content = path.read_bytes()
        digest = sha256_hex(content)
        file_id = str(uuid4())
        inbox_id = str(uuid4())
        storage_key = f"test/e2/{stem}/{file_id}.pdf"
        storage.put(storage_key, content, "application/pdf")
        conn.execute(
            """
            INSERT INTO books_files (
              id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                file_id,
                DESERT_CLIENT_ID,
                digest,
                storage_key,
                f"{stem}.pdf",
                "application/pdf",
                len(content),
                OMAR,
            ),
        )
        conn.execute(
            """
            INSERT INTO books_inbox_items (id, client_id, file_id, status)
            VALUES (%s, %s, %s, 'queued')
            """,
            (inbox_id, DESERT_CLIENT_ID, file_id),
        )
        conn.commit()
        process_extract_document(conn, storage, {"inboxItemId": inbox_id, "fileId": file_id})
        conn.commit()
        return inbox_id

    inbox_a = _run("bank_a")
    stmts_a = conn.execute(
        """
        SELECT id, iban, opening_balance_minor, closing_balance_minor, status, validation_flags
        FROM books_statement_extractions WHERE inbox_item_id = %s ORDER BY iban
        """,
        (inbox_a,),
    ).fetchall()
    assert len(stmts_a) == 1
    assert stmts_a[0]["iban"] == BANK_A_EXPECTED["iban"]
    assert stmts_a[0]["opening_balance_minor"] == BANK_A_EXPECTED["opening_minor"]
    assert stmts_a[0]["closing_balance_minor"] == BANK_A_EXPECTED["closing_minor"]
    assert stmts_a[0]["status"] == "ready"
    flags_a = stmts_a[0]["validation_flags"]
    if isinstance(flags_a, str):
        flags_a = json.loads(flags_a)
    assert "balance_ok" in flags_a

    lines_a = conn.execute(
        """
        SELECT line_date, description, debit_minor, credit_minor, running_balance_minor, source_bbox
        FROM books_statement_lines WHERE statement_id = %s ORDER BY sort_index
        """,
        (stmts_a[0]["id"],),
    ).fetchall()
    assert len(lines_a) == 2
    assert lines_a[0]["description"] == "CLIENT RECEIPT"
    assert lines_a[0]["credit_minor"] == 50_000
    assert lines_a[1]["debit_minor"] == 20_000
    for ln in lines_a:
        bbox = ln["source_bbox"]
        if isinstance(bbox, str):
            bbox = json.loads(bbox)
        assert bbox is not None
        assert bbox.get("page") is not None
        assert bbox.get("bbox") is not None and len(bbox["bbox"]) == 4

    # Re-upload same inbox → no duplicate lines
    process_extract_document(
        conn,
        storage,
        {
            "inboxItemId": inbox_a,
            "fileId": conn.execute(
                "SELECT file_id FROM books_inbox_items WHERE id = %s", (inbox_a,)
            ).fetchone()["file_id"],
        },
    )
    conn.commit()
    assert (
        conn.execute(
            "SELECT count(*) AS c FROM books_statement_extractions WHERE inbox_item_id = %s",
            (inbox_a,),
        ).fetchone()["c"]
        == 1
    )
    assert (
        conn.execute(
            """
            SELECT count(*) AS c FROM books_statement_lines
            WHERE statement_id = (
              SELECT id FROM books_statement_extractions WHERE inbox_item_id = %s LIMIT 1
            )
            """,
            (inbox_a,),
        ).fetchone()["c"]
        == 2
    )

    inbox_c = _run("bank_c_multi_iban")
    stmts_c = conn.execute(
        """
        SELECT id, iban, opening_balance_minor, closing_balance_minor, status, validation_flags
        FROM books_statement_extractions WHERE inbox_item_id = %s ORDER BY iban
        """,
        (inbox_c,),
    ).fetchall()
    assert len(stmts_c) == 2
    by_iban = {r["iban"]: r for r in stmts_c}
    first = by_iban["AE070331234567890123456"]
    second = by_iban["AE460090000000123456789"]
    assert first["opening_balance_minor"] == 50_000
    assert first["closing_balance_minor"] == 75_000
    assert first["status"] == "ready"
    flags_first = first["validation_flags"]
    if isinstance(flags_first, str):
        flags_first = json.loads(flags_first)
    assert "balance_ok" in flags_first

    assert second["opening_balance_minor"] is None
    assert second["closing_balance_minor"] is None
    assert second["status"] == "needs_review"
    flags_second = second["validation_flags"]
    if isinstance(flags_second, str):
        flags_second = json.loads(flags_second)
    assert "balances_not_found" in flags_second
    assert second["opening_balance_minor"] != 0 or second["opening_balance_minor"] is None


def test_word_boxes_present_on_bank_pdf():
    path = PDFS / "bank_a.pdf"
    if not path.exists():
        pytest.skip("bank_a.pdf missing")
    word_boxes, page_texts, _m = collect_pdf_word_boxes(path.read_bytes())
    assert page_texts and "ACCOUNT STATEMENT" in page_texts[0]
    words = [w for w in word_boxes if "text" in w and "x0" in w]
    assert words
    assert all(isinstance(w.get("page"), int) and w["page"] >= 1 for w in words)
