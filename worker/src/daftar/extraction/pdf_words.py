"""Collect per-page PDF word boxes (text-layer + OCR) in PDF points, origin top-left."""

from __future__ import annotations

from typing import Any

from daftar.textclean import clean_text, page_has_usable_text_layer, text_layer_unreliable
from daftar.textnorm import arabic_indic_to_ascii


def _has_text_layer(text: str, words: list) -> bool:
    """Same usable-text rule as extract_file / ocr_engine."""
    return page_has_usable_text_layer(text, word_count=len(words or []))


def ocr_tokens_to_word_boxes(
    tokens: list[Any],
    *,
    page: int,
    page_width: float,
    page_height: float,
    image_width: float,
    image_height: float,
    engine: str = "ocr",
) -> list[dict[str, Any]]:
    """Map OCR tokens (image pixels) into PDF-point word boxes for review highlights."""
    if image_width <= 0 or image_height <= 0:
        return []
    sx = page_width / float(image_width)
    sy = page_height / float(image_height)
    out: list[dict[str, Any]] = []
    for tok in tokens:
        text = arabic_indic_to_ascii(clean_text(str(getattr(tok, "text", "") or "")))
        if not text:
            continue
        conf = getattr(tok, "confidence", None)
        try:
            conf_f = float(conf) if conf is not None else 0.7
        except (TypeError, ValueError):
            conf_f = 0.7
        out.append(
            {
                "page": page,
                "x0": float(getattr(tok, "x0", 0)) * sx,
                "y0": float(getattr(tok, "y0", 0)) * sy,
                "x1": float(getattr(tok, "x1", 0)) * sx,
                "y1": float(getattr(tok, "y1", 0)) * sy,
                "text": text,
                "conf": conf_f,
                "engine": engine,
            }
        )
    return out


def image_tokens_to_word_boxes(
    tokens: list[Any],
    *,
    page: int = 1,
    width: float,
    height: float,
    engine: str = "ocr",
) -> list[dict[str, Any]]:
    """Word boxes for a pure image document (coords = processed image pixels)."""
    page_meta = {"page": page, "width": float(width), "height": float(height)}
    words = ocr_tokens_to_word_boxes(
        tokens,
        page=page,
        page_width=float(width),
        page_height=float(height),
        image_width=float(width),
        image_height=float(height),
        engine=engine,
    )
    return [page_meta, *words]


def collect_pdf_word_boxes(
    content: bytes,
    *,
    run_ocr: bool = False,
) -> tuple[list[dict[str, Any]], list[str], list[tuple[int, str]]]:
    """Return (word_boxes, page_texts, methods).

    word_boxes entries:
      - words: {page, x0, y0, x1, y1, text, conf}
      - pages: {page, width, height}
    methods: [(page_no, "pdf_text"|"ocr_skipped"|"doctr"|"easyocr"|...)]

    When run_ocr=False (default, cheap path for early probes), scanned pages are
    marked ocr_skipped with no word tokens. Production extract_file merges OCR
    boxes afterward. Lab/eval may pass run_ocr=True to fill boxes in one pass.
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
                if run_ocr:
                    engine, ocr_text, boxes = _ocr_page_boxes(page, index)
                    methods.append((index, engine))
                    page_texts[-1] = ocr_text
                    word_boxes.extend(boxes)
                else:
                    methods.append((index, "text_layer_unreliable"))
                continue
            text = clean_text(arabic_indic_to_ascii(raw))
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
                            "text": clean_text(arabic_indic_to_ascii(str(word[4]))),
                            "conf": 1.0,
                        }
                    )
            else:
                if run_ocr:
                    engine, ocr_text, boxes = _ocr_page_boxes(page, index)
                    methods.append((index, engine))
                    page_texts[-1] = ocr_text
                    word_boxes.extend(boxes)
                else:
                    methods.append((index, "ocr_skipped"))
    finally:
        document.close()

    return word_boxes, page_texts, methods


def _ocr_page_boxes(page: Any, page_no: int) -> tuple[str, str, list[dict[str, Any]]]:
    """Rasterise one PDF page, OCR, return (engine, text, word_boxes in PDF points)."""
    from PIL import Image

    from daftar.extract import recognize

    zoom = 2.0
    import fitz

    pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    processed, tokens = recognize(image)
    engine = str(getattr(recognize, "last_engine", "ocr") or "ocr")
    ocr_text = arabic_indic_to_ascii(clean_text(" ".join(t.text for t in tokens)))
    boxes = ocr_tokens_to_word_boxes(
        tokens,
        page=page_no,
        page_width=float(page.rect.width),
        page_height=float(page.rect.height),
        image_width=float(processed.size[0]),
        image_height=float(processed.size[1]),
        engine=engine,
    )
    return engine, ocr_text, boxes


def words_on_page(word_boxes: list[dict[str, Any]], page: int) -> list[dict[str, Any]]:
    return [
        w
        for w in word_boxes
        if w.get("page") == page and "text" in w and "x0" in w
    ]


def merge_word_boxes(
    base: list[dict[str, Any]],
    extra: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge OCR/extra word tokens into base; keep first page-dimension entry per page."""
    if not extra:
        return list(base or [])
    if not base:
        return list(extra)
    pages_with_words = {
        int(w["page"])
        for w in base
        if w.get("page") is not None and "text" in w and "x0" in w
    }
    out = list(base)
    for w in extra:
        if "text" in w and "x0" in w:
            p = int(w["page"])
            if p in pages_with_words:
                continue
            out.append(w)
            pages_with_words.add(p)
        elif "width" in w and "height" in w and "text" not in w:
            # Skip duplicate page metas already present.
            p = int(w["page"])
            if any(
                x.get("page") == p and "width" in x and "text" not in x for x in out
            ):
                continue
            out.append(w)
    return out
