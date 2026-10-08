#!/usr/bin/env python3
"""Generate ING-5 synthetic PDFs + ground_truth (exact fils). Run from repo root or this dir."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
(PDFS := ROOT / "pdfs").mkdir(exist_ok=True)
(GT := ROOT / "ground_truth").mkdir(exist_ok=True)


def _write_pdf(path: Path, text: str) -> None:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    # Multi-line: insert_text only does one line — use textwriter / insert_htmlbox
    y = 72
    for line in text.splitlines():
        page.insert_text((50, y), line, fontsize=11, fontname="helv")
        y += 14
    doc.save(path)
    doc.close()


def _gt_invoice(**kwargs):
    return {"route": "text", **kwargs}


def main() -> None:
    sales = """TAX INVOICE
Desert Falcon Services FZE
TRN 100000000000001
Bill To: Oasis Retail LLC
TRN 100123456700003
Invoice No: INV-ING5-001
Date: 15/05/2026
Consulting services    10000.00
Subtotal               10000.00
VAT 5%                   500.00
Grand Total            10500.00
Currency AED
"""
    _write_pdf(PDFS / "sales_tax_invoice.pdf", sales)
    (GT / "sales_tax_invoice.json").write_text(
        json.dumps(
            _gt_invoice(
                doc_type="sales_invoice",
                invoice_no="INV-ING5-001",
                invoice_date="2026-05-15",
                currency="AED",
                supplier_trn="100000000000001",
                customer_trn="100123456700003",
                net=1_000_000,
                vat=50_000,
                gross=1_050_000,
            ),
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    purch = """TAX INVOICE
Gulf Supplies LLC
TRN 100999999999999
Bill To: Desert Falcon Services FZE
TRN 100000000000001
Invoice No: BILL-ING5-002
Date: 16/05/2026
Office supplies         2000.00
Subtotal                2000.00
VAT 5%                   100.00
Grand Total             2100.00
Currency AED
"""
    _write_pdf(PDFS / "purchase_with_trn.pdf", purch)
    (GT / "purchase_with_trn.json").write_text(
        json.dumps(
            _gt_invoice(
                doc_type="purchase_bill",
                invoice_no="BILL-ING5-002",
                invoice_date="2026-05-16",
                currency="AED",
                supplier_trn="100999999999999",
                customer_trn="100000000000001",
                net=200_000,
                vat=10_000,
                gross=210_000,
            ),
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    purch_no = """TAX INVOICE
Cash Market Stall
Bill To: Desert Falcon Services FZE
TRN 100000000000001
Invoice No: BILL-ING5-003
Date: 17/05/2026
Office supplies         2000.00
Subtotal                2000.00
VAT 5%                   100.00
Grand Total             2100.00
Currency AED
"""
    _write_pdf(PDFS / "purchase_no_trn.pdf", purch_no)
    (GT / "purchase_no_trn.json").write_text(
        json.dumps(
            _gt_invoice(
                doc_type="purchase_bill",
                invoice_no="BILL-ING5-003",
                invoice_date="2026-05-17",
                currency="AED",
                supplier_trn=None,
                customer_trn="100000000000001",
                net=200_000,
                vat=10_000,
                gross=210_000,
            ),
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    rc = """TAX INVOICE
Foreign Counsel LLP
Bill To: Desert Falcon Services FZE
TRN 100000000000001
Invoice No: BILL-ING5-RC
Date: 18/05/2026
Legal advisory USD      1000.00
Subtotal                1000.00
Grand Total             1000.00
Currency USD
Reverse charge
"""
    _write_pdf(PDFS / "purchase_rc_usd.pdf", rc)
    (GT / "purchase_rc_usd.json").write_text(
        json.dumps(
            _gt_invoice(
                doc_type="purchase_bill",
                invoice_no="BILL-ING5-RC",
                invoice_date="2026-05-18",
                currency="USD",
                supplier_trn=None,
                net=100_000,
                vat=0,
                gross=100_000,
                reverse_charge=True,
            ),
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    cn = """CREDIT NOTE
Desert Falcon Services FZE
TRN 100000000000001
Bill To: Oasis Retail LLC
TRN 100123456700003
Credit Note No: CN-ING5-001
Date: 20/05/2026
Against INV-ING5-001
Consulting credit        1000.00
Subtotal                 1000.00
VAT 5%                     50.00
Grand Total              1050.00
Currency AED
"""
    _write_pdf(PDFS / "credit_note_s1.pdf", cn)
    (GT / "credit_note_s1.json").write_text(
        json.dumps(
            _gt_invoice(
                doc_type="credit_note",
                invoice_no="CN-ING5-001",
                invoice_date="2026-05-20",
                currency="AED",
                net=100_000,
                vat=5_000,
                gross=105_000,
            ),
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    bank = """ACCOUNT STATEMENT
Bank: Synthetic UAE Bank ING5
IBAN: AE070331234567890123456
Period: 01/05/2026 to 31/05/2026
Opening balance: 50000.00
20/05/2026 CLIENT RECEIPT INV-ING5-001 10500.00 CR
21/05/2026 SUPPLIER PAYMENT BILL-ING5-002 2100.00 DR
22/05/2026 BANK CHARGE 52.50 DR
23/05/2026 UNMATCHED CREDIT 100.00 CR
Closing balance: 58447.50
"""
    _write_pdf(PDFS / "bank_stmt_match.pdf", bank)
    (GT / "bank_stmt_match.json").write_text(
        json.dumps(
            {
                "doc_type": "bank_statement",
                "route": "text",
                "iban": "AE070331234567890123456",
                "currency": "AED",
                "period_from": "2026-05-01",
                "period_to": "2026-05-31",
                "opening_minor": 5_000_000,
                "closing_minor": 5_844_750,
                "lines": [
                    {
                        "txn_date": "2026-05-20",
                        "description": "CLIENT RECEIPT INV-ING5-001",
                        "debit_minor": 0,
                        "credit_minor": 1_050_000,
                    },
                    {
                        "txn_date": "2026-05-21",
                        "description": "SUPPLIER PAYMENT BILL-ING5-002",
                        "debit_minor": 210_000,
                        "credit_minor": 0,
                    },
                    {
                        "txn_date": "2026-05-22",
                        "description": "BANK CHARGE",
                        "debit_minor": 5_250,
                        "credit_minor": 0,
                    },
                    {
                        "txn_date": "2026-05-23",
                        "description": "UNMATCHED CREDIT",
                        "debit_minor": 0,
                        "credit_minor": 10_000,
                    },
                ],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"Wrote ING-5 fixtures under {ROOT}")


if __name__ == "__main__":
    main()
