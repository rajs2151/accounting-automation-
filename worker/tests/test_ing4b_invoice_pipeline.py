"""ING-4b: Arabic-Indic norm, layout, candidates, OCR box merge (mocked — no new PDFs)."""

from __future__ import annotations

from daftar.extraction.candidates import (
    document_kind_flags,
    pick_best,
    score_date_candidates,
    score_trn_candidates,
)
from daftar.extraction.fields import extract_invoice_fields, normalize_trn, parse_amount_fils
from daftar.extraction.layout import cluster_lines, key_value_pairs_from_lines, page_lines, split_two_columns
from daftar.extraction.pdf_words import merge_word_boxes, ocr_tokens_to_word_boxes
from daftar.money import parse_amount
from daftar.textnorm import arabic_indic_to_ascii


def test_arabic_indic_digits_to_ascii():
    assert arabic_indic_to_ascii("٢٠٢٦") == "2026"
    assert arabic_indic_to_ascii("۱۲۳") == "123"
    assert normalize_trn("١٠٠٠٠٠٠٠٠٠٠٠٠٠٣") == "100000000000003"
    assert parse_amount_fils("١,٢٣٤.٥٠") == 123450
    assert parse_amount("١٢٣٤.٥٠") == 123450


def test_layout_two_column_and_kv():
    words = [
        {"page": 1, "x0": 10, "y0": 10, "x1": 40, "y1": 20, "text": "Seller"},
        {"page": 1, "x0": 10, "y0": 25, "x1": 80, "y1": 35, "text": "TRN"},
        {"page": 1, "x0": 200, "y0": 10, "x1": 260, "y1": 20, "text": "Buyer"},
        {"page": 1, "x0": 200, "y0": 25, "x1": 280, "y1": 35, "text": "Co"},
    ]
    left, right = split_two_columns(words, page_width=300)
    assert any(w["text"] == "Seller" for w in left)
    assert any(w["text"] == "Buyer" for w in right)
    lines = page_lines(words, 1)
    assert len(cluster_lines(words)) >= 2
    pairs = key_value_pairs_from_lines(
        [{"text": "Invoice No: INV-9"}, {"text": "Date"}, {"text": "12/05/2026"}]
    )
    assert ("Invoice No", "INV-9") in pairs
    assert ("Date", "12/05/2026") in pairs


def test_trn_and_date_candidates_prefer_labeled():
    text = (
        "Noise TRN 100000000000001 somewhere\n"
        "Tax Registration Number: 100000000000099\n"
        "Invoice Date: 15/03/2026\n"
        "Other 01/01/2020\n"
    )
    best_trn = pick_best(score_trn_candidates(text))
    assert best_trn is not None
    assert best_trn.value == "100000000000099"
    best_date = pick_best(score_date_candidates(text))
    assert best_date is not None
    assert "15/03/2026" in best_date.value


def test_document_kind_flags():
    assert "credit_note" in document_kind_flags("CREDIT NOTE CN-12")
    assert "proforma_or_quote" in document_kind_flags("Pro-forma Invoice")
    assert "debit_note" in document_kind_flags("Debit Note DN-3")


def test_ocr_tokens_scaled_to_pdf_points():
    tok = type("T", (), {"text": "Total", "x0": 100, "y0": 50, "x1": 200, "y1": 70, "confidence": 0.9})()
    boxes = ocr_tokens_to_word_boxes(
        [tok],
        page=1,
        page_width=300,
        page_height=400,
        image_width=600,
        image_height=800,
        engine="doctr",
    )
    assert len(boxes) == 1
    assert boxes[0]["x0"] == 50.0  # 100 * (300/600)
    assert boxes[0]["engine"] == "doctr"


def test_merge_word_boxes_fills_ocr_page_only():
    base = [
        {"page": 1, "width": 100, "height": 100},
        {"page": 1, "x0": 1, "y0": 1, "x1": 2, "y1": 2, "text": "A", "conf": 1.0},
        {"page": 2, "width": 100, "height": 100},
    ]
    extra = [
        {"page": 1, "x0": 9, "y0": 9, "x1": 10, "y1": 10, "text": "SKIP", "conf": 0.5},
        {"page": 2, "x0": 3, "y0": 3, "x1": 4, "y1": 4, "text": "OCR", "conf": 0.8},
    ]
    merged = merge_word_boxes(base, extra)
    texts = [w["text"] for w in merged if "text" in w]
    assert "A" in texts
    assert "OCR" in texts
    assert "SKIP" not in texts


def test_extract_invoice_fields_arabic_amount_and_cn_flag():
    text = (
        "CREDIT NOTE\n"
        "Invoice No CN-88\n"
        "Date 12/05/2026\n"
        "TRN 100000000000003\n"
        "Subtotal ١٠٠.٠٠\n"
        "VAT ٥.٠٠\n"
        "Grand Total ١٠٥.٠٠\n"
        "Currency AED\n"
    )
    out = extract_invoice_fields(text, route="text", page_texts=[text], word_boxes=[])
    assert out.get("gross") == 10500 or out["fields"]["gross"].get("value") == 10500
    assert "credit_note" in (out.get("flags") or [])


def test_auto_rotate_prefers_upright():
    from PIL import Image, ImageDraw

    from daftar.extract import _auto_rotate_cardinal

    # Wide horizontal bar → high row variance when upright.
    img = Image.new("L", (200, 80), 255)
    draw = ImageDraw.Draw(img)
    draw.rectangle([10, 30, 190, 50], fill=0)
    sideways = img.rotate(90, expand=True, fillcolor=255)
    fixed = _auto_rotate_cardinal(sideways)
    # After correction, width should be closer to original landscape aspect.
    assert fixed.size[0] >= fixed.size[1]
