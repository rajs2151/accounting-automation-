"""Addendum A OCR: docTR primary, EasyOCR Arabic/low-confidence fallback."""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from functools import lru_cache

from PIL import Image

logger = logging.getLogger("daftar.ocr_engine")

ARABIC_RE = re.compile(r"[\u0600-\u06FF]")

DOCTR_DET = os.environ.get("DOCTR_DET_ARCH", "db_resnet50")
DOCTR_RECO = os.environ.get("DOCTR_RECO_ARCH", "crnn_vgg16_bn")


@dataclass
class OcrToken:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    confidence: float
    engine: str


@dataclass
class OcrResult:
    tokens: list[OcrToken]
    engine: str
    model_names: list[str]
    mean_confidence: float


def arabic_script_ratio(text: str) -> float:
    if not text:
        return 0.0
    arabic = sum(1 for ch in text if ARABIC_RE.match(ch))
    return arabic / max(len(text), 1)


def doctr_installed() -> bool:
    try:
        import doctr  # noqa: F401
        from doctr.models import ocr_predictor  # noqa: F401

        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("doctr_import_failed: %s", exc)
        return False


def easyocr_installed() -> bool:
    try:
        import easyocr  # noqa: F401

        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("easyocr_import_failed: %s", exc)
        return False


@lru_cache(maxsize=1)
def _doctr_predictor():
    from doctr.models import ocr_predictor

    return ocr_predictor(det_arch=DOCTR_DET, reco_arch=DOCTR_RECO, pretrained=True)


@lru_cache(maxsize=1)
def _easyocr_reader():
    import easyocr

    langs = os.environ.get("EASYOCR_LANGS", "en,ar").split(",")
    return easyocr.Reader([lang.strip() for lang in langs if lang.strip()], gpu=False)


def loaded_model_report() -> dict:
    """For acceptance report / health checks."""
    report = {
        "doctr_installed": doctr_installed(),
        "easyocr_installed": easyocr_installed(),
        "doctr_det_arch": DOCTR_DET,
        "doctr_reco_arch": DOCTR_RECO,
        "easyocr_langs": os.environ.get("EASYOCR_LANGS", "en,ar"),
        "models_loaded": [],
    }
    if report["doctr_installed"]:
        try:
            _doctr_predictor()
            report["models_loaded"].append(f"doctr:{DOCTR_DET}+{DOCTR_RECO}")
        except Exception as exc:  # noqa: BLE001
            report["doctr_load_error"] = str(exc)[:200]
    if report["easyocr_installed"]:
        try:
            _easyocr_reader()
            report["models_loaded"].append(f"easyocr:{report['easyocr_langs']}")
        except Exception as exc:  # noqa: BLE001
            report["easyocr_load_error"] = str(exc)[:200]
    return report


def recognize_image(image: Image.Image, force_easyocr: bool = False) -> OcrResult:
    """Run OCR. Prefer docTR; fall back to EasyOCR when Arabic or low mean confidence."""
    rgb = image.convert("RGB")
    if force_easyocr or os.environ.get("OCR_FORCE_EASYOCR") == "1":
        if easyocr_installed():
            return _run_easyocr(rgb)
        return _run_tesseract_fallback(rgb)

    if not doctr_installed():
        if easyocr_installed():
            return _run_easyocr(rgb)
        return _run_tesseract_fallback(rgb)

    result = _run_doctr(rgb)
    text = " ".join(t.text for t in result.tokens)
    need_fallback = (
        result.mean_confidence < 0.55
        or arabic_script_ratio(text) > 0.15
        or os.environ.get("OCR_FORCE_EASYOCR_FALLBACK") == "1"
    )
    if need_fallback and easyocr_installed():
        logger.info(
            "easyocr_fallback mean_conf=%.3f arabic_ratio=%.3f",
            result.mean_confidence,
            arabic_script_ratio(text),
        )
        return _run_easyocr(rgb)
    return result


def _run_doctr(image: Image.Image) -> OcrResult:
    import io

    from doctr.io import DocumentFile

    predictor = _doctr_predictor()
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    pages = DocumentFile.from_images([buf.getvalue()])
    out = predictor(pages)
    tokens: list[OcrToken] = []
    confs: list[float] = []
    page = out.pages[0]
    h, w = page.dimensions
    for block in page.blocks:
        for line in block.lines:
            for word in line.words:
                (x0, y0), (x1, y1) = word.geometry
                conf = float(word.confidence or 0.0)
                confs.append(conf)
                tokens.append(
                    OcrToken(
                        text=word.value,
                        x0=float(x0) * w,
                        y0=float(y0) * h,
                        x1=float(x1) * w,
                        y1=float(y1) * h,
                        confidence=conf,
                        engine="doctr",
                    )
                )
    mean = sum(confs) / len(confs) if confs else 0.0
    return OcrResult(
        tokens=tokens,
        engine="doctr",
        model_names=[DOCTR_DET, DOCTR_RECO],
        mean_confidence=mean,
    )


def _run_easyocr(image: Image.Image) -> OcrResult:
    import numpy as np

    reader = _easyocr_reader()
    arr = np.array(image.convert("RGB"))
    rows = reader.readtext(arr)
    tokens: list[OcrToken] = []
    confs: list[float] = []
    for box, text, conf in rows:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        c = float(conf)
        confs.append(c)
        tokens.append(
            OcrToken(
                text=str(text),
                x0=float(min(xs)),
                y0=float(min(ys)),
                x1=float(max(xs)),
                y1=float(max(ys)),
                confidence=c,
                engine="easyocr",
            )
        )
    mean = sum(confs) / len(confs) if confs else 0.0
    langs = os.environ.get("EASYOCR_LANGS", "en,ar")
    return OcrResult(
        tokens=tokens,
        engine="easyocr",
        model_names=[f"easyocr:{langs}"],
        mean_confidence=mean,
    )


def _run_tesseract_fallback(image: Image.Image) -> OcrResult:
    """Last resort only if docTR/EasyOCR missing — Phase 1 image must ship both."""
    import pytesseract

    data = pytesseract.image_to_data(
        image, lang="eng+ara", config="--psm 6", output_type=pytesseract.Output.DICT
    )
    tokens: list[OcrToken] = []
    confs: list[float] = []
    for i, text in enumerate(data["text"]):
        text = (text or "").strip()
        if not text:
            continue
        try:
            conf = float(data["conf"][i]) / 100.0
        except (TypeError, ValueError):
            continue
        if conf < 0:
            continue
        x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
        confs.append(conf)
        tokens.append(OcrToken(text, x, y, x + w, y + h, conf, "tesseract"))
    mean = sum(confs) / len(confs) if confs else 0.0
    return OcrResult(
        tokens=tokens,
        engine="tesseract",
        model_names=["tesseract:eng+ara"],
        mean_confidence=mean,
    )


def page_has_text_layer(text: str, min_chars: int | None = None) -> bool:
    from daftar.textclean import page_has_usable_text_layer

    return page_has_usable_text_layer(text, min_chars=min_chars)
