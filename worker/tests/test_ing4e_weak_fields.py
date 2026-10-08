"""ING-4e: weak real-docs fields — stacked VAT, Bill From issuer, favour fallback."""

from __future__ import annotations

from daftar.extraction.fields import extract_invoice_fields


def test_stacked_vat_percent_label():
    text = (
        "TAX INVOICE\n"
        "Desert Falcon Services FZE\n"
        "TRN 100000000000001\n"
        "Bill To: Gulf Crest Trading LLC\n"
        "Subtotal 100.00\n"
        "Vat (5%)\n"
        "5.00\n"
        "Total 105.00\n"
    )
    fields = extract_invoice_fields(text, route="text", page_texts=[text])
    assert fields.get("net") == 10000
    assert fields.get("vat") == 500
    assert fields.get("gross") == 10500


def test_vat_derived_from_net_and_gross_when_unlabelled():
    text = (
        "BILL\n"
        "Bill From\n"
        "Alyah FZCO\n"
        "TRN 100000000000099\n"
        "Sub Total\n"
        "200.00\n"
        "Total\n"
        "210.00\n"
    )
    fields = extract_invoice_fields(text, route="text", page_texts=[text])
    assert fields.get("issuer_name") == "Alyah FZCO"
    assert fields.get("net") == 20000
    assert fields.get("gross") == 21000
    assert fields.get("vat") == 1000
    assert "vat_derived_from_totals" in (fields.get("flags") or [])


def test_payment_favour_beats_tax_invoice_customer_block():
    text = (
        "TAX INVOICE\n"
        "Hub71 Ltd\n"
        "ADGM Square\n"
        "Subtotal 50.00\n"
        "Total No Tax 0%\n"
        "0.00\n"
        "Invoice Total AED 50.00\n"
        'Payment to be made in favor of "BEDOUIN HOMES FOR REAL ESTATE LLC" to the following bank\n'
        "Account name: BEDOUIN HOMES FOR REAL ESTATE LLC\n"
    )
    fields = extract_invoice_fields(text, route="text", page_texts=[text])
    assert fields.get("issuer_name")
    assert "BEDOUIN" in fields["issuer_name"].upper()
    assert "HUB71" not in fields["issuer_name"].upper()
