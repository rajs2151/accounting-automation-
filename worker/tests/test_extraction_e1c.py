"""E1c: real-layout invoice extraction (TRN, roles, dates, VAT evidence, line table)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from daftar.extraction.classify import TRN_RE as CLASSIFY_TRN_RE
from daftar.extraction.company_match import TRN_RE as MATCH_TRN_RE
from daftar.extraction.fields import (
    TRN_RE,
    extract_invoice_fields,
    infer_vat_code,
    normalize_trn,
    parse_invoice_date,
)
from daftar.extraction.pdf_words import collect_pdf_word_boxes

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "extraction"
PDFS = FIXTURES / "pdfs"
GT = FIXTURES / "ground_truth"


def _extract(stem: str):
    path = PDFS / f"{stem}.pdf"
    if not path.exists():
        pytest.skip(f"missing fixture {path} — run generate_synthetic.py")
    content = path.read_bytes()
    word_boxes, page_texts, _methods = collect_pdf_word_boxes(content)
    fields = extract_invoice_fields(
        "\n".join(page_texts),
        route="text",
        page_texts=page_texts,
        word_boxes=word_boxes,
    )
    return fields, word_boxes, page_texts


def test_e1c_layout_extracts_roles_trns_totals_and_exempt_line():
    gt = json.loads((GT / "invoice_e1c_layout.json").read_text(encoding="utf-8"))
    fields, _wb, _pages = _extract("invoice_e1c_layout")

    assert fields.get("issuer_name") == gt["issuer_name"]
    assert fields.get("customer_name") == gt["customer_name"]
    assert fields.get("issuer_trn") == gt["issuer_trn"]
    assert fields.get("customer_trn") == gt["customer_trn"]
    assert fields.get("invoice_no") == gt["invoice_no"]
    assert fields.get("invoice_date") == gt["invoice_date"]
    assert fields.get("currency") == gt["currency"]
    assert fields.get("net") == gt["net"]
    assert fields.get("vat") == 0
    assert fields.get("gross") == gt["gross"]

    meta = fields.get("fields") or {}
    for key in (
        "issuer_name",
        "customer_name",
        "issuer_trn",
        "customer_trn",
        "invoice_no",
        "invoice_date",
        "currency",
        "net",
        "vat",
        "gross",
    ):
        entry = meta.get(key) or {}
        assert entry.get("value") is not None or entry.get("value") == 0, key
        assert "confidence" in entry, key
        src = entry.get("source")
        assert src is not None, f"{key} missing source"
        assert src.get("page") == 1, key
        assert isinstance(src.get("bbox"), list) and len(src["bbox"]) == 4, key

    lines = fields.get("line_items") or []
    assert lines, "expected line items"
    line = lines[0]
    assert gt["line_description"] in str(line.get("description") or "")
    assert line.get("vat_code") == "EX"
    assert line.get("net") == gt["net"]
    assert line.get("source") is not None
    assert "vat_code_missing" not in (fields.get("flags") or [])
    # Roles must not be swapped
    assert fields.get("issuer_name") != fields.get("customer_name")
    assert "Sample Holiday Homes" in (fields.get("issuer_name") or "")
    assert "Example Trading" in (fields.get("customer_name") or "")


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("105181487700003", "105181487700003"),
        ("1051 8148 7700 003", "105181487700003"),
        ("1051-8148-7700-003", "105181487700003"),
        ("100000000000099", "100000000000099"),
        ("10000000000009", None),  # 14 digits
        ("1000000000000999", None),  # 16 digits
        ("200000000000001", None),  # does not start with 1
    ],
)
def test_trn_normalize_length_only(raw: str, expected: str | None):
    assert normalize_trn(raw) == expected


def test_trn_regex_accepts_non_100_rejects_bad_length():
    assert TRN_RE.search("TRN 105181487700003")
    assert TRN_RE.search("100000000000001")
    assert not TRN_RE.search("10518148770000")  # 14
    assert not TRN_RE.search("1051814877000033")  # 16
    assert CLASSIFY_TRN_RE.search("105181487700003")
    assert MATCH_TRN_RE.search("105181487700003")
    # Spaced form after compact (company_match) / flex normalize
    assert normalize_trn("1051 8148 7700 003") == "105181487700003"


@pytest.mark.parametrize(
    "raw,iso",
    [
        ("28 Jan 2026", "2026-01-28"),
        ("28-Jan-2026", "2026-01-28"),
        ("Jan 28, 2026", "2026-01-28"),
        ("28.01.2026", "2026-01-28"),
        ("15/05/2026", "2026-05-15"),
        ("2026-05-15", "2026-05-15"),
    ],
)
def test_date_formats_parse_to_iso(raw: str, iso: str):
    got, scale, _amb = parse_invoice_date(raw)
    assert got == iso
    assert scale > 0


def test_ambiguous_numeric_date_assumes_dd_mm_lower_conf():
    iso, scale, ambiguous = parse_invoice_date("05/06/2026")
    assert iso == "2026-06-05"  # dd/mm UAE
    assert ambiguous is True
    assert scale < 1.0


def test_missing_vat_evidence_null_code_not_sr():
    """No Tax/VAT evidence on lines → vat_code null + flag; never invent SR."""
    text = (
        "TAX INVOICE\nDesert Falcon Services FZE\nTRN 100000000000001\n"
        "Bill To: Oasis Retail LLC\nTRN 100123456700003\n"
        "Invoice No: INV-MISS-VAT\nDate: 15/05/2026\n"
        "Consulting services    100.00\n"
        "Total                  100.00\n"
    )
    fields = extract_invoice_fields(text, route="text", page_texts=[text], word_boxes=[])
    lines = fields.get("line_items") or []
    assert lines
    assert lines[0].get("vat_code") is None
    assert lines[0].get("vat_code") != "SR"
    assert "vat_code_missing" in (fields.get("flags") or [])
    assert infer_vat_code("") is None
    assert infer_vat_code("Tax Exempt") == "EX"
    assert infer_vat_code("VAT 5%") == "SR"


def test_vat_zero_from_total_no_tax_is_valid():
    fields, _wb, _pages = _extract("invoice_e1c_layout")
    vat = (fields.get("fields") or {}).get("vat") or {}
    assert vat.get("value") == 0
    assert vat.get("status") in {"ok", "low"}
