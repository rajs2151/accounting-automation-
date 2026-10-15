"""Rebuild lines / blocks / key-value pairs from word boxes (Addendum A §1.5)."""

from __future__ import annotations

import re
from typing import Any

from daftar.textnorm import arabic_indic_to_ascii, strip_duplicated_arabic_labels


def cluster_lines(
    words: list[dict[str, Any]],
    *,
    y_tol: float | None = None,
) -> list[list[dict[str, Any]]]:
    """Group word boxes into reading-order lines (top→bottom, LTR within line)."""
    usable = [w for w in words if w.get("text") and "x0" in w]
    if not usable:
        return []
    heights = [max(1.0, float(w["y1"]) - float(w["y0"])) for w in usable]
    heights.sort()
    median_h = heights[len(heights) // 2]
    tol = y_tol if y_tol is not None else max(4.0, median_h * 0.55)
    ordered = sorted(usable, key=lambda w: ((float(w["y0"]) + float(w["y1"])) / 2, float(w["x0"])))
    lines: list[list[dict[str, Any]]] = [[ordered[0]]]
    current_y = (float(ordered[0]["y0"]) + float(ordered[0]["y1"])) / 2
    for w in ordered[1:]:
        mid = (float(w["y0"]) + float(w["y1"])) / 2
        if abs(mid - current_y) <= tol:
            lines[-1].append(w)
            current_y = sum((float(x["y0"]) + float(x["y1"])) / 2 for x in lines[-1]) / len(lines[-1])
        else:
            lines.append([w])
            current_y = mid
    for line in lines:
        line.sort(key=lambda w: float(w["x0"]))
    return lines


def line_text(line: list[dict[str, Any]]) -> str:
    raw = " ".join(str(w.get("text") or "") for w in line)
    return strip_duplicated_arabic_labels(arabic_indic_to_ascii(raw))


def page_lines(word_boxes: list[dict[str, Any]], page: int) -> list[dict[str, Any]]:
    """Return {text, words, y0, y1, x0, x1} per line on one page."""
    words = [w for w in word_boxes if w.get("page") == page and "text" in w and "x0" in w]
    out: list[dict[str, Any]] = []
    for line in cluster_lines(words):
        xs0 = [float(w["x0"]) for w in line]
        ys0 = [float(w["y0"]) for w in line]
        xs1 = [float(w["x1"]) for w in line]
        ys1 = [float(w["y1"]) for w in line]
        out.append(
            {
                "text": line_text(line),
                "words": line,
                "x0": min(xs0),
                "y0": min(ys0),
                "x1": max(xs1),
                "y1": max(ys1),
            }
        )
    return out


def split_two_columns(
    words: list[dict[str, Any]],
    *,
    page_width: float | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split party header words into left/right columns by median x mid-point."""
    usable = [w for w in words if "x0" in w and w.get("text")]
    if not usable:
        return [], []
    mids = sorted((float(w["x0"]) + float(w["x1"])) / 2 for w in usable)
    mid = mids[len(mids) // 2]
    if page_width and page_width > 0:
        mid = page_width / 2.0
    left = [w for w in usable if (float(w["x0"]) + float(w["x1"])) / 2 < mid]
    right = [w for w in usable if (float(w["x0"]) + float(w["x1"])) / 2 >= mid]
    return left, right


_LABEL_ONLY = re.compile(
    r"(?i)^(Invoice\s*(No|Number|#)|Date|Issue\s*Date|Due\s*Date|TRN|"
    r"Tax\s*Registration(?:\s*Number)?|Currency|Subtotal|VAT|Total)$"
)


def key_value_pairs_from_lines(lines: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """Parse 'Label: value' and stacked label/value lines."""
    pairs: list[tuple[str, str]] = []
    i = 0
    while i < len(lines):
        text = str(lines[i].get("text") or "").strip()
        if ":" in text or "：" in text:
            sep = "：" if "：" in text else ":"
            key, _, val = text.partition(sep)
            key, val = key.strip(), val.strip()
            if key and val:
                pairs.append((key, val))
            elif key and i + 1 < len(lines):
                nxt = str(lines[i + 1].get("text") or "").strip()
                if nxt and ":" not in nxt and "：" not in nxt:
                    pairs.append((key, nxt))
                    i += 1
        elif _LABEL_ONLY.match(text) and i + 1 < len(lines):
            nxt = str(lines[i + 1].get("text") or "").strip()
            if nxt and not _LABEL_ONLY.match(nxt) and ":" not in nxt and "：" not in nxt:
                pairs.append((text, nxt))
                i += 1
        i += 1
    return pairs


def union_bbox(words: list[dict[str, Any]]) -> list[float] | None:
    if not words:
        return None
    return [
        min(float(w["x0"]) for w in words),
        min(float(w["y0"]) for w in words),
        max(float(w["x1"]) for w in words),
        max(float(w["y1"]) for w in words),
    ]
