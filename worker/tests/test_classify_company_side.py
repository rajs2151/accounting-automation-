"""Invoice side when the company is on neither party (synthetic text only)."""

from __future__ import annotations

from daftar.extraction.classify import classify_document

COMPANY_TRN = "100000000000003"
COMPANY = "Synthetic Falcon Services FZE"

THIRD_PARTY_INVOICE = """TAX INVOICE
Northwind Trading LLC
TRN 100000000000095
Invoice No INV-0042   Invoice Date 28 Jan 2026
Bill To: Contoso Homes LLC, TRN 100000000000111
Consulting services   1,000.00   VAT 5% 50.00   Total 1,050.00
"""


def test_company_on_neither_side_needs_review_not_sales():
    c = classify_document(
        "inv.pdf", THIRD_PARTY_INVOICE, company_trn=COMPANY_TRN, company_name=COMPANY
    )
    assert c.doc_type == "purchase_bill"
    assert c.needs_user_pick is True
    assert c.confidence < 0.55
    assert "company_not_on_invoice" in c.reasons


def test_company_as_issuer_or_customer_still_decides_the_side():
    issued = THIRD_PARTY_INVOICE.replace("Northwind Trading LLC", COMPANY).replace(
        "TRN 100000000000095", f"TRN {COMPANY_TRN}"
    )
    c = classify_document("inv.pdf", issued, company_trn=COMPANY_TRN, company_name=COMPANY)
    assert (c.doc_type, c.needs_user_pick) == ("sales_invoice", False)

    received = THIRD_PARTY_INVOICE.replace("Contoso Homes LLC", COMPANY).replace(
        "TRN 100000000000111", f"TRN {COMPANY_TRN}"
    )
    c = classify_document("inv.pdf", received, company_trn=COMPANY_TRN, company_name=COMPANY)
    assert (c.doc_type, c.needs_user_pick) == ("purchase_bill", False)


def test_without_company_context_keeps_previous_guess():
    c = classify_document("inv.pdf", THIRD_PARTY_INVOICE)
    assert c.doc_type == "sales_invoice"
