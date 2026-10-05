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


def _gt(stem: str) -> dict:
    return json.loads((GT / f"{stem}.json").read_text(encoding="utf-8"))


def _line_view(ln: dict) -> dict:
    if "debit_minor" in ln or "credit_minor" in ln:
        debit = int(ln.get("debit_minor") or 0)
        credit = int(ln.get("credit_minor") or 0)
    else:
        amount = int(ln.get("amount_minor") or 0)
        if ln.get("debit"):
            debit, credit = amount, 0
        else:
            debit, credit = 0, amount
    return {
        "txn_date": ln.get("txn_date"),
        "description": ln.get("description"),
        "debit_minor": debit,
        "credit_minor": credit,
        "amount_minor": int(ln.get("amount_minor") or (debit or credit)),
        "running_balance_minor": ln.get("running_balance_minor"),
    }


def _assert_account_matches_gt(acct: dict, expected: dict) -> None:
    assert acct["iban"] == expected["iban"]
    assert acct["bank_name"] == expected["bank_name"]
    assert acct["period_from"] == expected["period_from"]
    assert acct["period_to"] == expected["period_to"]
    assert acct["opening_minor"] == expected["opening_minor"]
    assert acct["closing_minor"] == expected["closing_minor"]
    assert acct.get("currency") == expected.get("currency", "AED")
    assert len(acct["lines"]) == len(expected["lines"])
    for got, exp in zip(acct["lines"], expected["lines"], strict=True):
        assert _line_view(got) == exp


def _balance_ok(opening: int, closing: int, lines: list[dict]) -> bool:
    running = opening
    for ln in lines:
        v = _line_view(ln)
        running = running + v["credit_minor"] - v["debit_minor"]
    return running == closing


@pytest.mark.parametrize("stem", ["bank_a", "bank_b_bilingual"])
def test_bank_ab_header_and_lines_match(stem: str):
    gt = _gt(stem)
    assert gt["doc_type"] == "bank_statement"

    text = (TEXT / f"{stem}.txt").read_text(encoding="utf-8")
    accounts = parse_bank_statement_text(text)
    assert len(accounts) == 1
    _assert_account_matches_gt(accounts[0], gt)
    assert _balance_ok(gt["opening_minor"], gt["closing_minor"], accounts[0]["lines"])
    # No balance column → running balance must stay null (not invented).
    assert all(ln.get("running_balance_minor") is None for ln in accounts[0]["lines"])

    cls = classify_document("upload.pdf", text)
    assert cls.doc_type == gt["doc_type"]
    assert cls.confidence >= 0.55

    pdf = PDFS / f"{stem}.pdf"
    if not pdf.exists():
        pytest.skip(f"{stem}.pdf missing")
    parsed = BankStatementPdfParser().parse(f"{stem}.pdf", "application/pdf", pdf.read_bytes())
    assert parsed.doc_type == "bank_statement"
    assert parsed.extras.get("opening_minor") == gt["opening_minor"]
    assert parsed.extras.get("closing_minor") == gt["closing_minor"]
    assert len(parsed.lines) == len(gt["lines"])
    for ln in parsed.lines:
        src = (ln.meta or {}).get("source") or {}
        assert src.get("page") is not None, ln.description
        assert src.get("bbox") is not None and len(src["bbox"]) == 4, ln.description


def test_bank_c_multi_iban_attribution_ambiguous():
    gt = _gt("bank_c_multi_iban")
    assert gt["doc_type"] == "bank_statement"

    text = (TEXT / "bank_c_multi_iban.txt").read_text(encoding="utf-8")
    accounts = parse_bank_statement_text(text)
    assert len(accounts) == 2
    by_iban = {a["iban"]: a for a in accounts}

    for exp in gt["accounts"]:
        got = by_iban[exp["iban"]]
        assert got["balances_found"] is exp["balances_found"]
        assert got["opening_minor"] == exp["opening_minor"]
        assert got["closing_minor"] == exp["closing_minor"]
        assert bool(got.get("account_attribution_ambiguous")) is exp["account_attribution_ambiguous"]
        assert len(got["lines"]) == len(exp["lines"])
        for g_ln, e_ln in zip(got["lines"], exp["lines"], strict=True):
            assert _line_view(g_ln) == e_ln

    owner = by_iban["AE460090000000123456789"]
    other = by_iban["AE070331234567890123456"]
    assert owner["account_attribution_ambiguous"] is True
    assert other["balances_found"] is False
    assert other["lines"] == []

    cls = classify_document("upload.pdf", text)
    assert cls.doc_type == gt["doc_type"]


def test_pick_parser_content_not_filename():
    path = PDFS / "bank_a.pdf"
    if not path.exists():
        pytest.skip("bank_a.pdf missing")
    content = path.read_bytes()
    parser, conf = pick_parser("upload.pdf", "application/pdf", content)
    assert parser is not None
    assert parser.name == "bank_statement_pdf"
    assert conf >= 70


def test_identical_same_day_fees_both_kept():
    """Defect a: two identical fees on the same day without running balance → both kept."""
    text = """ACCOUNT STATEMENT
Bank: Synthetic UAE Bank A
IBAN: AE070331234567890123456
Period: 01/05/2026 to 31/05/2026
Opening balance: 1,000.00
10/05/2026 BANK FEE 25.00 DR
10/05/2026 BANK FEE 25.00 DR
Closing balance: 950.00
"""
    accounts = parse_bank_statement_text(text)
    assert len(accounts) == 1
    assert len(accounts[0]["lines"]) == 2
    assert accounts[0]["lines"][0]["description"] == "BANK FEE"
    assert accounts[0]["lines"][1]["description"] == "BANK FEE"
    assert accounts[0]["lines"][0]["amount_minor"] == 2500
    assert accounts[0]["lines"][1]["amount_minor"] == 2500
    assert accounts[0]["lines"][0]["running_balance_minor"] is None
    assert accounts[0]["lines"][1]["running_balance_minor"] is None


def test_debit_credit_column_lines_accepted():
    """Defect c: debit/credit columns without CR/DR suffix are not dropped."""
    text = """ACCOUNT STATEMENT
Bank: Synthetic UAE Bank A
IBAN: AE070331234567890123456
Period: 01/05/2026 to 31/05/2026
Opening balance: 1,000.00
05/05/2026 CLIENT RECEIPT 0.00 500.00
10/05/2026 OFFICE RENT 200.00 0.00
Closing balance: 1,300.00
"""
    accounts = parse_bank_statement_text(text)
    assert len(accounts[0]["lines"]) == 2
    assert accounts[0]["lines"][0]["credit_minor"] == 50000
    assert accounts[0]["lines"][0]["debit"] is False
    assert accounts[0]["lines"][1]["debit_minor"] == 20000
    assert accounts[0]["lines"][1]["debit"] is True
    assert all(ln.get("running_balance_minor") is None for ln in accounts[0]["lines"])


def test_balance_column_fixture_reads_printed_balances():
    """Defect b/c: balance-column fixture → printed balances + continuity passes."""
    gt = _gt("bank_d_balance_col")
    text = (TEXT / "bank_d_balance_col.txt").read_text(encoding="utf-8")
    accounts = parse_bank_statement_text(text)
    assert len(accounts) == 1
    _assert_account_matches_gt(accounts[0], gt)

    from daftar.extraction import _running_balance_continuity, _stmt_line_dict

    lines = [_stmt_line_dict(ln) for ln in accounts[0]["lines"]]
    assert _running_balance_continuity(gt["opening_minor"], lines) is None
    assert _balance_ok(gt["opening_minor"], gt["closing_minor"], accounts[0]["lines"])


def test_tampered_printed_balance_needs_review_names_line(ctx):
    """Defect b: continuity break → needs_review naming the line."""
    conn, storage = ctx
    text = (TEXT / "bank_d_balance_col.txt").read_text(encoding="utf-8")
    # Break continuity on second fee: printed 1,450.00 → 1,400.00
    tampered = text.replace("10/05/2026 BANK FEE 25.00 DR 1,450.00", "10/05/2026 BANK FEE 25.00 DR 1,400.00")
    content = tampered.encode("utf-8")

    accounts = parse_bank_statement_text(tampered)
    assert accounts[0]["lines"][2]["running_balance_minor"] == 140000
    from daftar.extraction import _running_balance_continuity, _stmt_line_dict

    lines = [_stmt_line_dict(ln) for ln in accounts[0]["lines"]]
    brk = _running_balance_continuity(100_000, lines)
    assert brk is not None
    assert brk["description"] == "BANK FEE"
    assert brk["diff"] == -5000  # printed 140000 vs expected 145000

    digest = sha256_hex(content)
    file_id = str(uuid4())
    inbox_id = str(uuid4())
    storage_key = f"test/e2-balcol/{file_id}.txt"
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
        SELECT status, validation_flags
        FROM books_statement_extractions WHERE inbox_item_id = %s
        """,
        (inbox_id,),
    ).fetchone()
    assert row is not None
    assert row["status"] == "needs_review"
    flags_val = row["validation_flags"]
    if isinstance(flags_val, str):
        flags_val = json.loads(flags_val)
    assert "running_balance_break" in flags_val
    assert "running_balance_break_line:BANK FEE" in flags_val
    assert f"running_balance_diff:{brk['diff']}" in flags_val
    assert "balance_ok" not in flags_val


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
    """Full pipeline: bank_a ready+balance_ok; bank_c both needs_review (ambiguous + not found)."""
    conn, storage = ctx
    gt_a = _gt("bank_a")
    gt_c = _gt("bank_c_multi_iban")

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
    assert stmts_a[0]["iban"] == gt_a["iban"]
    assert stmts_a[0]["opening_balance_minor"] == gt_a["opening_minor"]
    assert stmts_a[0]["closing_balance_minor"] == gt_a["closing_minor"]
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
    assert lines_a[0]["running_balance_minor"] is None
    assert lines_a[1]["debit_minor"] == 20_000
    assert lines_a[1]["running_balance_minor"] is None
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

    # Position: activity after both IBANs → second IBAN owns it, flagged ambiguous.
    assert second["opening_balance_minor"] == gt_c["accounts"][1]["opening_minor"]
    assert second["closing_balance_minor"] == gt_c["accounts"][1]["closing_minor"]
    assert second["status"] == "needs_review"
    flags_second = second["validation_flags"]
    if isinstance(flags_second, str):
        flags_second = json.loads(flags_second)
    assert "account_attribution_ambiguous" in flags_second
    assert "balance_ok" not in flags_second
    assert second["status"] != "ready"

    assert first["opening_balance_minor"] is None
    assert first["closing_balance_minor"] is None
    assert first["status"] == "needs_review"
    flags_first = first["validation_flags"]
    if isinstance(flags_first, str):
        flags_first = json.loads(flags_first)
    assert "balances_not_found" in flags_first


def test_identical_fees_survive_pipeline(ctx):
    """Defect a via pipeline: within-statement dedupe must not drop a duplicate fee."""
    conn, storage = ctx
    text = """ACCOUNT STATEMENT
Bank: Synthetic UAE Bank A
IBAN: AE070331234567890123456
Period: 01/05/2026 to 31/05/2026
Opening balance: 1,000.00
10/05/2026 BANK FEE 25.00 DR
10/05/2026 BANK FEE 25.00 DR
Closing balance: 950.00
"""
    content = text.encode("utf-8")
    digest = sha256_hex(content)
    file_id = str(uuid4())
    inbox_id = str(uuid4())
    storage_key = f"test/e2-dupfee/{file_id}.txt"
    storage.put(storage_key, content, "text/plain")
    conn.execute(
        """
        INSERT INTO books_files (
          id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (file_id, DESERT_CLIENT_ID, digest, storage_key, "fees.txt", "text/plain", len(content), OMAR),
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

    stmt = conn.execute(
        "SELECT id, status, validation_flags FROM books_statement_extractions WHERE inbox_item_id = %s",
        (inbox_id,),
    ).fetchone()
    assert stmt is not None
    assert stmt["status"] == "ready"
    n = conn.execute(
        "SELECT count(*) AS c FROM books_statement_lines WHERE statement_id = %s",
        (stmt["id"],),
    ).fetchone()["c"]
    assert n == 2
    rbs = conn.execute(
        "SELECT running_balance_minor FROM books_statement_lines WHERE statement_id = %s ORDER BY sort_index",
        (stmt["id"],),
    ).fetchall()
    assert all(r["running_balance_minor"] is None for r in rbs)


def test_word_boxes_present_on_bank_pdf():
    path = PDFS / "bank_a.pdf"
    if not path.exists():
        pytest.skip("bank_a.pdf missing")
    word_boxes, page_texts, _m = collect_pdf_word_boxes(path.read_bytes())
    assert page_texts and "ACCOUNT STATEMENT" in page_texts[0]
    words = [w for w in word_boxes if "text" in w and "x0" in w]
    assert words
    assert all(isinstance(w.get("page"), int) and w["page"] >= 1 for w in words)
