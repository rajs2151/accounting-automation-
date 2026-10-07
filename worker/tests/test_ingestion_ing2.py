"""ING-2: OCR wiring, XLSX, card PDF safety, job fail/stuck recovery."""

from __future__ import annotations

from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from daftar.errors import CodedError
from daftar.extract import Extraction, extract_file
from daftar.parsers.base import pick_parser
from daftar.parsers.card_generic import CardGenericParser
from daftar.parsers.invoice_generic import InvoiceGenericParser


def _fake_ocr_image(image, page_no: int):
    # Mimic _ocr_image return: headers, rows, png, width, height, ocr_text
    text = "TAX INVOICE\nInvoice No INV-MOCK-1\nDate 2026-05-12\nTotal 105.00 AED"
    return [], [], b"", 100, 100, text


def test_png_bill_goes_through_ocr_mocked():
    parser = InvoiceGenericParser()
    png_magic = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    with patch("daftar.extract._ocr_image", side_effect=_fake_ocr_image):
        with patch("daftar.extract.Image") as img_mod:
            img_mod.open.return_value = SimpleNamespace(
                convert=lambda *_a, **_k: SimpleNamespace(),
            )
            with patch("daftar.extract.ImageOps") as ops:
                ops.exif_transpose.side_effect = lambda im: im
                doc = parser.parse("bill.png", "image/png", png_magic)
    assert doc.ocr_used is True
    assert "INV-MOCK-1" in (doc.extras or {}).get("raw_text", "")


def test_extract_file_image_stores_raw_pages():
    png_magic = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    with patch("daftar.extract._ocr_image", side_effect=_fake_ocr_image):
        with patch("daftar.extract.Image") as img_mod:
            img_mod.open.return_value = SimpleNamespace(
                convert=lambda *_a, **_k: SimpleNamespace(),
            )
            with patch("daftar.extract.ImageOps") as ops:
                ops.exif_transpose.side_effect = lambda im: im
                extraction = extract_file(png_magic, "image")
    assert isinstance(extraction, Extraction)
    assert extraction.raw_pages
    assert "TAX INVOICE" in extraction.raw_pages[0]


def test_scanned_pdf_fields_filled_from_ocr_text():
    """Scanned PDF: OCR page text is what field extraction reads (not empty text layer)."""
    # Amounts must end the line (GROSS_LABEL_RE); use Grand Total so TOTAL_RE
    # does not falsely match the "Total" inside "Subtotal".
    ocr_text = (
        "TAX INVOICE\n"
        "Invoice No INV-SCAN-9\n"
        "Date 12/05/2026\n"
        "TRN 100000000000003\n"
        "Subtotal 100.00\n"
        "VAT 5.00\n"
        "Grand Total 105.00\n"
    )
    fake = Extraction(
        headers=[],
        rows=[],
        methods=[(1, "doctr")],
        raw_pages=[ocr_text],
        kind="pdf",
    )
    with patch(
        "daftar.parsers.invoice_generic._pdf_pages",
        return_value=([""], [], [(1, "pdf_text")]),
    ):
        with patch("daftar.extract.extract_file", return_value=fake):
            doc = InvoiceGenericParser().parse(
                "scanned-bill.pdf",
                "application/pdf",
                b"%PDF-1.4 scanned",
            )
    assert doc.ocr_used is True
    extras = doc.extras or {}
    assert extras.get("invoice_no") == "INV-SCAN-9" or extras.get("document_number") == "INV-SCAN-9"
    assert extras.get("gross") == 10500 or extras.get("grand_total") == 10500
    assert "INV-SCAN-9" in (extras.get("raw_text") or "")


def test_xlsx_bank_parsed_without_ocr():
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Opening balance", "100.00"])
    ws.append(["Currency", "AED"])
    ws.append(["Date", "Description", "Debit", "Credit", "Balance"])
    ws.append(["2026-05-01", "Sale", "", "50.00", "150.00"])
    buf = BytesIO()
    wb.save(buf)
    content = buf.getvalue()

    with patch("daftar.extract._ocr_image") as ocr:
        extraction = extract_file(content, "xlsx")
        ocr.assert_not_called()

    assert extraction.kind == "xlsx"
    assert extraction.methods == [(1, "xlsx")]
    assert extraction.rows
    assert any("Sale" in (r.cells.get("Description") or "") for r in extraction.rows)


def test_card_statement_pdf_no_longer_crashes():
    pdf = b"%PDF-1.4\n" + b"\xff\xfe card statement binary " + b"\x00" * 32
    card = CardGenericParser()
    assert card.can_parse("card_statement.pdf", "application/pdf", pdf) == 0

    picked, _score = pick_parser("card_statement.pdf", "application/pdf", pdf)
    assert picked is None or picked.name != "card_generic"

    with pytest.raises(CodedError) as ei:
        card.parse("card_statement.pdf", "application/pdf", pdf)
    assert ei.value.code == "card_pdf_not_csv"


class _FakeResult:
    def __init__(self, rows=None, row=None):
        self._rows = rows or []
        self._row = row

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class _RecordingConn:
    def __init__(self):
        self.statements: list[tuple[str, tuple | None]] = []

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        return _FakeResult()

    def commit(self):
        pass

    def rollback(self):
        pass


def test_failed_job_marks_inbox_item_failed():
    from daftar.books_jobs import run_books_job

    conn = _RecordingConn()
    job = {
        "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "kind": "extract_document",
        "payload": {
            "inboxItemId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "attempt": 2,  # next attempt = 3 → final failure
        },
    }
    with patch("daftar.books_jobs._extract_document", side_effect=RuntimeError("extract_boom")):
        run_books_job(conn, job)

    inbox_failed = [
        (sql, params)
        for sql, params in conn.statements
        if "books_inbox_items" in sql and "failed" in sql
    ]
    assert inbox_failed, "inbox item must be marked failed after final extract attempt"
    assert any(
        "books_complete_job" in sql and params and params[-1] is not None
        for sql, params in conn.statements
        if "books_complete_job" in sql
    )


def test_stuck_running_job_is_requeued():
    from daftar.books_jobs import recover_stuck_books_jobs

    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [
        {"id": "1"},
        {"id": "2"},
    ]
    n = recover_stuck_books_jobs(conn)
    assert n == 2
    sql = conn.execute.call_args[0][0]
    assert "requeued_stuck" in sql
    assert "queued" in sql
    assert "running" in sql
