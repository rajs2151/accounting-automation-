"""ING-5a: worker extract on dedicated fixtures matches ground_truth fils."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from daftar.extraction.fields import extract_invoice_fields
from daftar.extraction.pdf_words import collect_pdf_word_boxes
from daftar.parsers.bank_statement_pdf import parse_bank_statement_text

ING5 = Path(__file__).resolve().parents[2] / "fixtures" / "extraction" / "ing5"
PDFS = ING5 / "pdfs"
GT = ING5 / "ground_truth"


def _load_gt(stem: str) -> dict:
    return json.loads((GT / f"{stem}.json").read_text(encoding="utf-8"))


def _extract_invoice(stem: str) -> dict:
    content = (PDFS / f"{stem}.pdf").read_bytes()
    boxes, pages, _m = collect_pdf_word_boxes(content)
    text = "\n".join(pages)
    return extract_invoice_fields(text, route="text", page_texts=pages, word_boxes=boxes)


@pytest.mark.parametrize(
    "stem,net,vat,gross",
    [
        ("sales_tax_invoice", 1_000_000, 50_000, 1_050_000),
        ("purchase_with_trn", 200_000, 10_000, 210_000),
        ("purchase_no_trn", 200_000, 10_000, 210_000),
        ("credit_note_s1", 100_000, 5_000, 105_000),
    ],
)
def test_ing5_invoice_amounts(stem: str, net: int, vat: int, gross: int):
    assert (PDFS / f"{stem}.pdf").is_file()
    gt = _load_gt(stem)
    out = _extract_invoice(stem)
    assert out.get("gross") == gross or (out.get("fields") or {}).get("gross", {}).get("value") == gross
    assert out.get("net") == net or (out.get("fields") or {}).get("net", {}).get("value") == net
    assert out.get("vat") == vat or (out.get("fields") or {}).get("vat", {}).get("value") == vat
    assert gt["gross"] == gross


def test_ing5_bank_statement_balances():
    content = (PDFS / "bank_stmt_match.pdf").read_bytes()
    boxes, pages, _m = collect_pdf_word_boxes(content)
    text = "\n".join(pages)
    accounts = parse_bank_statement_text(text, boxes)
    assert accounts
    acct = accounts[0]
    gt = _load_gt("bank_stmt_match")
    assert acct.get("opening_minor") == gt["opening_minor"]
    assert acct.get("closing_minor") == gt["closing_minor"]
    assert len(acct.get("lines") or []) >= 4
