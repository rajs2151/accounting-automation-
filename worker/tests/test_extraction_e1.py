"""E1: invoice/bill field extraction with page + bbox and word_boxes."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from daftar.extraction.classify import classify_document
from daftar.extraction.fields import extract_invoice_fields, find_source
from daftar.extraction.pdf_words import collect_pdf_word_boxes, words_on_page
from daftar.parsers.invoice_generic import InvoiceGenericParser

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "extraction"
PDFS = FIXTURES / "pdfs"
GT = FIXTURES / "ground_truth"


def _gt(stem: str) -> dict:
    return json.loads((GT / f"{stem}.json").read_text(encoding="utf-8"))


def _extract_pdf(stem: str):
    path = PDFS / f"{stem}.pdf"
    if not path.exists():
        pytest.skip(f"missing fixture {path}")
    content = path.read_bytes()
    word_boxes, page_texts, _methods = collect_pdf_word_boxes(content)
    fields = extract_invoice_fields(
        "\n".join(page_texts),
        route="text",
        page_texts=page_texts,
        word_boxes=word_boxes,
    )
    classification = classify_document(f"{stem}.pdf", "\n".join(page_texts))
    return fields, classification, word_boxes, page_texts, content


@pytest.mark.parametrize("stem", [f"invoice_{i:02d}" for i in range(1, 11)] + ["invoice_2page"])
def test_invoice_fixtures_match_ground_truth(stem: str):
    gt = _gt(stem)
    fields, classification, word_boxes, _pages, _content = _extract_pdf(stem)

    assert classification.doc_type == gt["doc_type"]
    assert fields.get("document_number") or fields.get("invoice_no") == gt["invoice_no"]
    assert fields.get("document_date") or fields.get("invoice_date") == gt["invoice_date"]
    assert fields.get("issuer_trn") or fields.get("supplier_trn") == gt["supplier_trn"]
    assert fields.get("gross") or fields.get("grand_total") == gt["grand_total"]

    # Found fields must carry source page + bbox
    for key in ("document_number", "document_date", "issuer_trn", "gross"):
        meta = (fields.get("fields") or {}).get(key) or {}
        if meta.get("status") == "missing":
            continue
        src = meta.get("source")
        assert src is not None, key
        assert src.get("page") is not None, key
        assert src.get("bbox") is not None, key
        assert len(src["bbox"]) == 4, key

    # word_boxes non-empty with page numbers for text PDFs
    word_entries = [w for w in word_boxes if "text" in w and "x0" in w]
    assert word_entries, stem
    assert all(isinstance(w.get("page"), int) and w["page"] >= 1 for w in word_entries)


def test_invoice_2page_gross_source_on_page_2():
    fields, _cls, word_boxes, _pages, _content = _extract_pdf("invoice_2page")
    gross = (fields.get("fields") or {}).get("gross") or {}
    assert gross.get("value") == 10500
    src = gross.get("source") or {}
    assert src.get("page") == 2
    bbox = src.get("bbox")
    assert bbox and len(bbox) == 4

    # bbox must contain the printed total amount word(s) on page 2
    page2_words = words_on_page(word_boxes, 2)
    amount_words = [w for w in page2_words if "105.00" in str(w.get("text") or "").replace(",", "")]
    assert amount_words, "expected 105.00 on page 2"
    ax0, ay0, ax1, ay1 = (
        min(w["x0"] for w in amount_words),
        min(w["y0"] for w in amount_words),
        max(w["x1"] for w in amount_words),
        max(w["y1"] for w in amount_words),
    )
    bx0, by0, bx1, by1 = bbox
    # Source bbox should overlap / contain the amount word box
    assert bx0 <= ax0 + 0.5 and by0 <= ay0 + 0.5
    assert bx1 >= ax1 - 0.5 and by1 >= ay1 - 0.5


def test_no_vat_line_stays_missing():
    path = PDFS / "invoice_no_vat.pdf"
    if not path.exists():
        pytest.skip("invoice_no_vat fixture missing — run generate_synthetic.py")
    fields, classification, _wb, _pages, _c = _extract_pdf("invoice_no_vat")
    assert classification.doc_type == "sales_invoice"
    vat = (fields.get("fields") or {}).get("vat") or {}
    assert vat.get("value") is None
    assert vat.get("status") == "missing"
    assert fields.get("gross") == 10000


def test_company_perspective_sales_vs_purchase():
    sales_text = (
        "TAX INVOICE\nDesert Falcon Services FZE\nTRN 100000000000001\n"
        "Bill To: Oasis Retail LLC\nTRN 100123456700003\nInvoice No: INV-1\n"
    )
    purchase_text = (
        "TAX INVOICE\nVendor Co LLC\nTRN 100999999999999\n"
        "Bill To: Desert Falcon Services FZE\nTRN 100000000000001\nInvoice No: BILL-1\n"
    )
    sales = classify_document(
        "inv.pdf",
        sales_text,
        company_trn="100000000000001",
        company_name="Desert Falcon Services FZE",
    )
    purchase = classify_document(
        "bill.pdf",
        purchase_text,
        company_trn="100000000000001",
        company_name="Desert Falcon Services FZE",
    )
    assert sales.doc_type == "sales_invoice"
    assert "issuer" in " ".join(sales.reasons)
    assert purchase.doc_type == "purchase_bill"
    assert "customer" in " ".join(purchase.reasons)


def test_parser_extracts_pdf_invoice_03():
    path = PDFS / "invoice_03.pdf"
    if not path.exists():
        pytest.skip("invoice_03.pdf missing")
    parsed = InvoiceGenericParser().parse("invoice_03.pdf", "application/pdf", path.read_bytes())
    assert parsed.doc_type == "sales_invoice"
    assert parsed.extras.get("invoice_no") == "INV-SYN-003"
    assert parsed.extras.get("gross") == 10500
    assert parsed.extras.get("supplier_trn") == "100000000000001"
    assert parsed.extras.get("word_boxes")
    assert classify_document("invoice_03.pdf", parsed.extras["raw_text"]).doc_type == "sales_invoice"


def test_find_source_bbox_shape():
    path = PDFS / "invoice_01.pdf"
    if not path.exists():
        pytest.skip("invoice_01.pdf missing")
    word_boxes, _pages, _m = collect_pdf_word_boxes(path.read_bytes())
    src = find_source(word_boxes, "105.00", prefer_pages=[1])
    assert src is not None
    assert src["page"] == 1
    assert len(src["bbox"]) == 4
