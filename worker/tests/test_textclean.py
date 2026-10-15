"""NUL bytes / unmapped-font text must never fail a job (owner hit "invalid byte sequence 0x00" on a real PDF)."""

import json
import sys
import types

from daftar.pipeline import AppConn
from daftar.textclean import (
    clean_param,
    clean_text,
    garbled_ratio,
    page_has_usable_text_layer,
    text_layer_unreliable,
)


def test_clean_text_strips_nul_and_controls_keeps_layout():
    assert clean_text("INV\x00-001\x07") == "INV-001"
    assert clean_text("Line 1\nLine 2\tTab\r\n") == "Line 1\nLine 2\tTab\r\n"
    assert clean_text("café") == "café"  # NFC
    assert clean_text("\ud800bad") == "bad"  # lone surrogate


def test_clean_param_cleans_nested_values_and_json_escapes():
    fields = {"party": {"value": "ACME\x00 LLC"}, "lines": [{"description": "Fee\x00"}]}
    params = ("id-1", "raw\x00text", json.dumps(fields), ["a\x00"], 42, None)
    cleaned = clean_param(params)
    assert cleaned[0] == "id-1"
    assert cleaned[1] == "rawtext"
    assert "\\u0000" not in cleaned[2]
    assert json.loads(cleaned[2]) == {"party": {"value": "ACME LLC"}, "lines": [{"description": "Fee"}]}
    assert cleaned[3] == ["a"]
    assert cleaned[4] == 42 and cleaned[5] is None


def test_garbled_text_layer_detected():
    real = "TAX INVOICE INV-SYN-002 Date 15/05/2026 Total 1,050.00"
    garbage = "\x00\x01\x02\x03" * 20 + "�" * 10
    assert garbled_ratio(real) == 0.0
    assert not text_layer_unreliable(real)
    assert text_layer_unreliable(garbage)
    assert text_layer_unreliable(" 12.00")  # private-use glyphs, unmapped font


def test_appconn_execute_never_sends_nul_to_postgres():
    seen = []

    class Raw:
        def execute(self, query, params=None, **kwargs):
            seen.append(params)

    conn = AppConn(Raw(), None)
    conn.execute("INSERT INTO t (a, b) VALUES (%s, %s::jsonb)", ("x\x00y", json.dumps({"v": "z\x00"})))
    assert seen[-1][0] == "xy"
    assert "\\u0000" not in seen[-1][1]


def test_pdf_words_routes_garbled_page_to_ocr(monkeypatch):
    """A page whose text layer is unmapped-font garbage gets no word boxes and is marked for OCR."""

    class Rect:
        width, height = 595.0, 842.0

    class Page:
        rect = Rect()

        def __init__(self, text, words):
            self._text, self._words = text, words

        def get_text(self, kind):
            return self._text if kind == "text" else self._words

    good = Page(
        "Invoice INV-1 Date 15/05/2026 Total 105.00 " * 2,
        [(10, 10, 50, 20, "Invoice", 0, 0, 0)],
    )
    bad = Page("\x00\x01\x02" * 40, [(10, 10, 50, 20, "\x00\x01", 0, 0, 0)])

    class Doc(list):
        def close(self):
            pass

    fake = types.SimpleNamespace(open=lambda **_: Doc([good, bad]))
    monkeypatch.setitem(sys.modules, "fitz", fake)

    from daftar.extraction.pdf_words import collect_pdf_word_boxes

    boxes, texts, methods = collect_pdf_word_boxes(b"%PDF-fake")
    assert methods == [(1, "pdf_text"), (2, "text_layer_unreliable")]
    assert texts[1] == ""
    assert all(b.get("page") != 2 or "text" not in b for b in boxes)
    assert all("\x00" not in b.get("text", "") for b in boxes)


def test_page_has_usable_text_layer_skips_ocr_on_digital_text():
    assert page_has_usable_text_layer(
        "TAX INVOICE INV-1 Date 15/05/2026 Subtotal 100.00 VAT 5.00 Total 105.00"
    )
    # Short totals page: few chars but real words → still digital.
    assert page_has_usable_text_layer(
        "VAT 5%                   5.00\nTotal                  105.00\n",
        word_count=4,
    )
    assert not page_has_usable_text_layer("short")
    assert not page_has_usable_text_layer("\x00\x01" * 40)
