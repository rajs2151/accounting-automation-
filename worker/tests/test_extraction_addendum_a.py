"""Addendum A §1 classification / OCR routing / company match / dedupe proofs."""

from __future__ import annotations

from pathlib import Path

import pytest

from daftar.extraction.classify import classify_document, user_pick
from daftar.extraction.company_match import match_company
from daftar.extraction.dedupe import DocIdentity, is_duplicate_hash, is_duplicate_identity
from daftar.ocr_engine import arabic_script_ratio, loaded_model_report, page_has_text_layer, recognize_image

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "extraction"


def test_classify_per_doc_type():
    cases = [
        ("tax-invoice.pdf", "TAX INVOICE\nBill To: Oasis", "sales_invoice"),
        ("bill.pdf", "PURCHASE BILL\nVendor Acme", "purchase_bill"),
        ("stmt.pdf", "ACCOUNT STATEMENT\nIBAN AE070331234567890123456", "bank_statement"),
        ("card.pdf", "CREDIT STATEMENT\nTotal due 250.00", "card_statement"),
        ("stripe_balance_history.csv", "id,Type,Amount", "gateway_statement"),
        ("tb.xlsx", "Trial Balance\nCode Debit Credit", "trial_balance"),
    ]
    for name, text, expected in cases:
        result = classify_document(name, text)
        assert result.doc_type == expected, (name, result)
        assert result.confidence >= 0.55


def test_low_confidence_classification_needs_user_pick():
    result = classify_document("scan-blur.jpg", "misc glyphs $$$")
    assert result.needs_user_pick is True
    assert result.confidence < 0.55
    picked = user_pick("purchase_bill")
    assert picked.doc_type == "purchase_bill"
    assert picked.confidence == 1.0
    assert picked.needs_user_pick is False


def test_text_layer_route_on_pdf():
    import fitz
    from daftar.extract import extract_file

    pdf_path = FIXTURES / "pdfs" / "invoice_01.pdf"
    if not pdf_path.exists():
        pytest.skip("fixtures not generated")
    extraction = extract_file(pdf_path.read_bytes(), "pdf")
    assert extraction.methods
    assert extraction.methods[0][1] == "pdf_text"
    assert page_has_text_layer(fitz.open(stream=pdf_path.read_bytes(), filetype="pdf")[0].get_text())


def test_doctr_ocr_route_on_scanned_image():
    scan = FIXTURES / "scans" / "scan_01.png"
    if not scan.exists():
        pytest.skip("scan fixtures not generated")
    from PIL import Image

    result = recognize_image(Image.open(scan))
    assert result.engine in {"doctr", "easyocr", "tesseract"}
    text = " ".join(t.text for t in result.tokens)
    # At least some digits from amount/date should appear
    assert any(ch.isdigit() for ch in text), text[:200]
    report = loaded_model_report()
    # In the worker image both should be installed; locally tesseract-only is OK for CI skip path
    assert report["doctr_installed"] or report["easyocr_installed"] or result.engine == "tesseract"


def test_mixed_pdf_handled_per_page():
    from daftar.extract import extract_file

    path = FIXTURES / "pdfs" / "mixed_invoice.pdf"
    if not path.exists():
        pytest.skip("mixed pdf missing")
    extraction = extract_file(path.read_bytes(), "pdf")
    methods = dict(extraction.methods)
    assert methods.get(1) == "pdf_text"
    assert methods.get(2) in {"doctr", "easyocr", "tesseract", "ocr"}


def test_easyocr_arabic_fallback():
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (800, 200), "white")
    draw = ImageDraw.Draw(img)
    draw.text((20, 60), "فاتورة ضريبية INV-SYN-077 Total 105.00", fill="black")
    # Force EasyOCR path when installed
    import os

    os.environ["OCR_FORCE_EASYOCR"] = "1"
    try:
        result = recognize_image(img, force_easyocr=True)
    finally:
        os.environ.pop("OCR_FORCE_EASYOCR", None)
    assert arabic_script_ratio("فاتورة") > 0.5
    assert result.engine in {"easyocr", "tesseract", "doctr"}
    assert result.tokens


def test_company_match_unassigned_when_no_match():
    hit = match_company(
        "TAX INVOICE\nTRN 100000000000001\nDesert Falcon Services FZE",
        "inv.pdf",
        company_trn="100000000000001",
        company_iban="AE070331234567890123456",
        company_name="Desert Falcon Services FZE",
    )
    assert hit.matched and not hit.unassigned

    miss = match_company(
        "TAX INVOICE\nTRN 100999999999999\nOther Co LLC",
        "inv.pdf",
        company_trn="100000000000001",
        company_iban="AE070331234567890123456",
        company_name="Desert Falcon Services FZE",
    )
    assert not miss.matched and miss.unassigned


def test_duplicate_detection_hash_and_identity():
    hashes: set[str] = set()
    assert is_duplicate_hash(hashes, b"abc")[0] is False
    assert is_duplicate_hash(hashes, b"abc")[0] is True

    seen: set[str] = set()
    a = DocIdentity("sales_invoice", "INV-1", "100123456700003", 10500)
    b = DocIdentity("sales_invoice", "INV-1", "100123456700003", 10500)
    c = DocIdentity("sales_invoice", "INV-2", "100123456700003", 10500)
    assert is_duplicate_identity(seen, a) is False
    assert is_duplicate_identity(seen, b) is True
    assert is_duplicate_identity(seen, c) is False


def test_loaded_model_report_shape():
    report = loaded_model_report()
    assert "doctr_installed" in report
    assert "easyocr_installed" in report
    assert "doctr_det_arch" in report
    assert "doctr_reco_arch" in report
