"""Collect per-page PDF word boxes (text-layer) in PDF points, origin top-left."""

from __future__ import annotations

import re
from typing import Any

from daftar.textclean import clean_text, text_layer_unreliable


def _has_text_layer(text: str, words: list) -> bool:
    """True when the page has a usable text layer (not a scanned image page, not unmapped-font garbage)."""
    if text_layer_unreliable(text):
        return False
    if words:
        return True
    compact = re.sub(r"\s+", "", text or "")
    return len(compact) >= 20


def collect_pdf_word_boxes(content: bytes) -> tuple[list[dict[str, Any]], list[str], list[tuple[int, str]]]:
    """Return (word_boxes, page_texts, methods).

    word_boxes entries:
      - words: {page, x0, y0, x1, y1, text, conf}
      - pages: {page, width, height}
    methods: [(page_no, "pdf_text"|"ocr_skipped")] — E1 only fills boxes for text pages.
    """
    import fitz

    word_boxes: list[dict[str, Any]] = []
    page_texts: list[str] = []
    methods: list[tuple[int, str]] = []

    document = fitz.open(stream=content, filetype="pdf")
    try:
        for index, page in enumerate(document, start=1):
            rect = page.rect
            word_boxes.append(
                {
                    "page": index,
                    "width": float(rect.width),
                    "height": float(rect.height),
                }
            )
            raw = page.get_text("text") or ""
            words = page.get_text("words") or []
            if text_layer_unreliable(raw):
                # Unmapped CID fonts: the text layer is garbage. Treat like a scanned page (OCR route).
                page_texts.append("")
                methods.append((index, "text_layer_unreliable"))
                continue
            text = clean_text(raw)
            page_texts.append(text)
            if _has_text_layer(text, words):
                methods.append((index, "pdf_text"))
                for word in words:
                    # PyMuPDF words: x0, y0, x1, y1, text, block, line, word
                    word_boxes.append(
                        {
                            "page": index,
                            "x0": float(word[0]),
                            "y0": float(word[1]),
                            "x1": float(word[2]),
                            "y1": float(word[3]),
                            "text": clean_text(str(word[4])),
                            "conf": 1.0,
                        }
                    )
            else:
                # OCR pages: keep existing extract.py behaviour elsewhere; no boxes in E1.
                methods.append((index, "ocr_skipped"))
    finally:
        document.close()

    return word_boxes, page_texts, methods


def words_on_page(word_boxes: list[dict[str, Any]], page: int) -> list[dict[str, Any]]:
    return [
        w
        for w in word_boxes
        if w.get("page") == page and "text" in w and "x0" in w
    ]
