#!/usr/bin/env python3
"""Generate synthetic extraction fixtures: text PDFs, scans, banks, card, Stripe CSV."""

from __future__ import annotations

import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent
for sub in ("text", "pdfs", "scans", "csv", "ground_truth", "predictions"):
    (ROOT / sub).mkdir(exist_ok=True)


def invoice_body(n: int, *, arabic: bool = False) -> str:
    inv = f"INV-SYN-{n:03d}"
    lines = [
        "TAX INVOICE",
        "Desert Falcon Services FZE",
        "TRN 100000000000001",
        "Bill To: Oasis Retail LLC",
        "TRN 100123456700003",
        f"Invoice No: {inv}",
        "Date: 15/05/2026",
        "Consulting services    100.00",
        "VAT 5%                   5.00",
        "Total                  105.00",
    ]
    if arabic:
        lines.insert(1, "فاتورة ضريبية")
        lines.append("المبلغ الإجمالي 105.00")
    return "\n".join(lines) + "\n"


BANK_A = """ACCOUNT STATEMENT
Bank: Synthetic UAE Bank A
IBAN: AE070331234567890123456
Period: 01/05/2026 to 31/05/2026
Opening balance: 1,000.00
05/05/2026 CLIENT RECEIPT 500.00 CR
10/05/2026 OFFICE RENT 200.00 DR
Closing balance: 1,300.00
"""

BANK_B = """ACCOUNT STATEMENT / كشف حساب
Bank: Synthetic UAE Bank B
IBAN: AE070331234567890123456
Period: 01/05/2026 to 31/05/2026
Opening balance: 2,000.00
الرصيد الافتتاحي 2,000.00
05/05/2026 RECEIPT 100.00 CR
Closing balance: 2,100.00
"""

BANK_C = """ACCOUNT STATEMENT
Bank: Multi-IBAN Synthetic Bank
Account 1 IBAN: AE070331234567890123456
Account 2 IBAN: AE460090000000123456789
Period: 01/05/2026 to 31/05/2026
Opening balance: 500.00
08/05/2026 TRANSFER IN 250.00 CR
Closing balance: 750.00
"""

# Balance-column variant: printed running balance on each line (read, not computed).
BANK_D_BALANCE_COL = """ACCOUNT STATEMENT
Bank: Synthetic UAE Bank BalCol
IBAN: AE070331234567890123456
Period: 01/05/2026 to 31/05/2026
Opening balance: 1,000.00
05/05/2026 CLIENT RECEIPT 500.00 CR 1,500.00
10/05/2026 BANK FEE 25.00 DR 1,475.00
10/05/2026 BANK FEE 25.00 DR 1,450.00
Closing balance: 1,450.00
"""


def _fils(aed: str) -> int:
    """'1,000.00' → 100000 (integer minor units)."""
    cleaned = aed.replace(",", "").strip()
    whole, _, frac = cleaned.partition(".")
    return int(whole or "0") * 100 + int((frac + "00")[:2])


def _bank_gt_a() -> dict:
    # Mapped from BANK_A constants above.
    return {
        "doc_type": "bank_statement",
        "route": "text",
        "bank_name": "Synthetic UAE Bank A",
        "iban": "AE070331234567890123456",
        "currency": "AED",
        "period_from": "2026-05-01",
        "period_to": "2026-05-31",
        "opening_minor": _fils("1,000.00"),
        "closing_minor": _fils("1,300.00"),
        "lines": [
            {
                "txn_date": "2026-05-05",
                "description": "CLIENT RECEIPT",
                "debit_minor": 0,
                "credit_minor": _fils("500.00"),
                "amount_minor": _fils("500.00"),
                "running_balance_minor": None,
            },
            {
                "txn_date": "2026-05-10",
                "description": "OFFICE RENT",
                "debit_minor": _fils("200.00"),
                "credit_minor": 0,
                "amount_minor": _fils("200.00"),
                "running_balance_minor": None,
            },
        ],
    }


def _bank_gt_b() -> dict:
    # Mapped from BANK_B constants above.
    return {
        "doc_type": "bank_statement",
        "route": "text",
        "bank_name": "Synthetic UAE Bank B",
        "iban": "AE070331234567890123456",
        "currency": "AED",
        "period_from": "2026-05-01",
        "period_to": "2026-05-31",
        "opening_minor": _fils("2,000.00"),
        "closing_minor": _fils("2,100.00"),
        "lines": [
            {
                "txn_date": "2026-05-05",
                "description": "RECEIPT",
                "debit_minor": 0,
                "credit_minor": _fils("100.00"),
                "amount_minor": _fils("100.00"),
                "running_balance_minor": None,
            },
        ],
    }


def _bank_gt_c() -> dict:
    # Mapped from BANK_C: activity sits after both IBANs → position-owned by IBAN 2.
    return {
        "doc_type": "bank_statement",
        "route": "text",
        "bank_name": "Multi-IBAN Synthetic Bank",
        "currency": "AED",
        "period_from": "2026-05-01",
        "period_to": "2026-05-31",
        "accounts": [
            {
                "iban": "AE070331234567890123456",
                "bank_name": "Multi-IBAN Synthetic Bank",
                "opening_minor": None,
                "closing_minor": None,
                "balances_found": False,
                "account_attribution_ambiguous": False,
                "flags": ["balances_not_found"],
                "lines": [],
            },
            {
                "iban": "AE460090000000123456789",
                "bank_name": "Multi-IBAN Synthetic Bank",
                "opening_minor": _fils("500.00"),
                "closing_minor": _fils("750.00"),
                "balances_found": True,
                "account_attribution_ambiguous": True,
                "flags": ["account_attribution_ambiguous"],
                "lines": [
                    {
                        "txn_date": "2026-05-08",
                        "description": "TRANSFER IN",
                        "debit_minor": 0,
                        "credit_minor": _fils("250.00"),
                        "amount_minor": _fils("250.00"),
                        "running_balance_minor": None,
                    },
                ],
            },
        ],
    }


def _bank_gt_d() -> dict:
    # Mapped from BANK_D_BALANCE_COL (printed balance column).
    return {
        "doc_type": "bank_statement",
        "route": "text",
        "bank_name": "Synthetic UAE Bank BalCol",
        "iban": "AE070331234567890123456",
        "currency": "AED",
        "period_from": "2026-05-01",
        "period_to": "2026-05-31",
        "opening_minor": _fils("1,000.00"),
        "closing_minor": _fils("1,450.00"),
        "lines": [
            {
                "txn_date": "2026-05-05",
                "description": "CLIENT RECEIPT",
                "debit_minor": 0,
                "credit_minor": _fils("500.00"),
                "amount_minor": _fils("500.00"),
                "running_balance_minor": _fils("1,500.00"),
            },
            {
                "txn_date": "2026-05-10",
                "description": "BANK FEE",
                "debit_minor": _fils("25.00"),
                "credit_minor": 0,
                "amount_minor": _fils("25.00"),
                "running_balance_minor": _fils("1,475.00"),
            },
            {
                "txn_date": "2026-05-10",
                "description": "BANK FEE",
                "debit_minor": _fils("25.00"),
                "credit_minor": 0,
                "amount_minor": _fils("25.00"),
                "running_balance_minor": _fils("1,450.00"),
            },
        ],
    }

CARD = """CREDIT STATEMENT
Card ending 4242
Previous balance 0.00
Purchases 250.00
Payments 0.00
Total due 250.00
Due date: 20/06/2026
"""

STRIPE = """id,Type,Source,Amount,Fee,Net,Currency,Created (UTC),Description
txn_1,charge,ch_1,100.00,3.20,96.80,aed,2026-05-05 10:00:00,Payment for INV-SYN-001
"""


def _write_pdf(path: Path, text: str) -> None:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((50, 72), text, fontsize=11, fontname="helv")
    doc.save(path)
    doc.close()


def _write_multipage_pdf(path: Path, pages: list[str]) -> None:
    import fitz

    doc = fitz.open()
    for text in pages:
        page = doc.new_page(width=595, height=842)
        page.insert_text((50, 72), text, fontsize=11, fontname="helv")
    doc.save(path)
    doc.close()


def invoice_2page_bodies() -> tuple[str, str]:
    """Header + line on page 1; VAT + Total on page 2 (page-aware totals fixture)."""
    page1 = "\n".join(
        [
            "TAX INVOICE",
            "Desert Falcon Services FZE",
            "TRN 100000000000001",
            "Bill To: Oasis Retail LLC",
            "TRN 100123456700003",
            "Invoice No: INV-SYN-2PG",
            "Date: 15/05/2026",
            "Consulting services    100.00",
            "Continued on next page",
        ]
    ) + "\n"
    page2 = "\n".join(
        [
            "VAT 5%                   5.00",
            "Total                  105.00",
        ]
    ) + "\n"
    return page1, page2


def invoice_no_vat_body() -> str:
    """Invoice with net + total but no VAT line — VAT must stay missing."""
    return (
        "\n".join(
            [
                "TAX INVOICE",
                "Desert Falcon Services FZE",
                "TRN 100000000000001",
                "Bill To: Oasis Retail LLC",
                "TRN 100123456700003",
                "Invoice No: INV-SYN-NOVAT",
                "Date: 15/05/2026",
                "Consulting services    100.00",
                "Total                  100.00",
            ]
        )
        + "\n"
    )


def purchase_bill_body() -> str:
    """Vendor bill where Desert Falcon is the customer (company-perspective purchase)."""
    return (
        "\n".join(
            [
                "TAX INVOICE",
                "Vendor Co LLC",
                "TRN 100999999999999",
                "Bill To: Desert Falcon Services FZE",
                "TRN 100000000000001",
                "Bill No: BILL-SYN-001",
                "Date: 15/05/2026",
                "Consulting services    100.00",
                "VAT 5%                   5.00",
                "Total                  105.00",
            ]
        )
        + "\n"
    )


# E1c real-layout synthetic (invented names only — never real client data).
E1C_ISSUER = "Sample Holiday Homes LLC"
E1C_ISSUER_TRN = "105181487700003"
E1C_CUSTOMER = "Example Trading Inc"
E1C_CUSTOMER_TRN = "100000000000099"
E1C_INV = "INV-E1C-001"
E1C_DATE = "28 Jan 2026"
E1C_LINE = "4th Rental Payment"
E1C_AMOUNT = "5000.00"
E1C_IBAN = "AE070331234567890123456"


def invoice_e1c_layout_text() -> str:
    """Plain-text proxy of the E1c layout (for text/ ground_truth companions)."""
    return (
        "\n".join(
            [
                "TAX INVOICE",
                E1C_CUSTOMER,
                f"TRN {E1C_CUSTOMER_TRN}",
                "Dubai Marina, UAE",
                E1C_ISSUER,
                f"TRN : {E1C_ISSUER_TRN}",
                "Business Bay, Dubai",
                "Invoice          Invoice Date",
                "Number           28 Jan 2026",
                E1C_INV,
                "Description          Quantity    Rate       Tax           Amount AED",
                f"{E1C_LINE}      1           {E1C_AMOUNT}   Tax Exempt    {E1C_AMOUNT}",
                f"Subtotal                                    {E1C_AMOUNT}",
                "Total No Tax 0%                              0.00",
                f"Invoice Total AED                           {E1C_AMOUNT}",
                f"Amount Due AED                              {E1C_AMOUNT}",
                f"Payment to be made in favour of {E1C_ISSUER}",
                f"Bank: Synthetic UAE Bank  IBAN: {E1C_IBAN}",
            ]
        )
        + "\n"
    )


def _write_e1c_layout_pdf(path: Path) -> None:
    """Issuer top-right, unlabelled customer top-left, stacked Invoice Number, Tax Exempt line."""
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    font = "helv"
    # Customer block (top-left, no Bill To label)
    page.insert_text((40, 60), E1C_CUSTOMER, fontsize=11, fontname=font)
    page.insert_text((40, 76), f"TRN {E1C_CUSTOMER_TRN}", fontsize=9, fontname=font)
    page.insert_text((40, 92), "Dubai Marina, UAE", fontsize=9, fontname=font)
    # Issuer block (top-right) with TRN label
    page.insert_text((320, 60), E1C_ISSUER, fontsize=11, fontname=font)
    page.insert_text((320, 76), f"TRN : {E1C_ISSUER_TRN}", fontsize=9, fontname=font)
    page.insert_text((320, 92), "Business Bay, Dubai", fontsize=9, fontname=font)
    page.insert_text((40, 120), "TAX INVOICE", fontsize=14, fontname=font)
    # Stacked labels: Invoice / Number  and Invoice Date / value
    page.insert_text((40, 160), "Invoice", fontsize=9, fontname=font)
    page.insert_text((40, 174), "Number", fontsize=9, fontname=font)
    page.insert_text((40, 190), E1C_INV, fontsize=11, fontname=font)
    page.insert_text((220, 160), "Invoice Date", fontsize=9, fontname=font)
    page.insert_text((220, 174), E1C_DATE, fontsize=11, fontname=font)
    # Table header + one Tax Exempt line
    page.insert_text((40, 230), "Description", fontsize=9, fontname=font)
    page.insert_text((250, 230), "Quantity", fontsize=9, fontname=font)
    page.insert_text((320, 230), "Rate", fontsize=9, fontname=font)
    page.insert_text((390, 230), "Tax", fontsize=9, fontname=font)
    page.insert_text((470, 230), "Amount AED", fontsize=9, fontname=font)
    page.insert_text((40, 250), E1C_LINE, fontsize=10, fontname=font)
    page.insert_text((260, 250), "1", fontsize=10, fontname=font)
    page.insert_text((320, 250), E1C_AMOUNT, fontsize=10, fontname=font)
    page.insert_text((380, 250), "Tax Exempt", fontsize=10, fontname=font)
    page.insert_text((480, 250), E1C_AMOUNT, fontsize=10, fontname=font)
    # Totals
    page.insert_text((320, 300), "Subtotal", fontsize=10, fontname=font)
    page.insert_text((480, 300), E1C_AMOUNT, fontsize=10, fontname=font)
    page.insert_text((320, 318), "Total No Tax 0%", fontsize=10, fontname=font)
    page.insert_text((480, 318), "0.00", fontsize=10, fontname=font)
    page.insert_text((320, 336), "Invoice Total AED", fontsize=10, fontname=font)
    page.insert_text((480, 336), E1C_AMOUNT, fontsize=10, fontname=font)
    page.insert_text((320, 354), "Amount Due AED", fontsize=10, fontname=font)
    page.insert_text((480, 354), E1C_AMOUNT, fontsize=10, fontname=font)
    # Bank footer / payment favour
    page.insert_text(
        (40, 420),
        f"Payment to be made in favour of {E1C_ISSUER}",
        fontsize=9,
        fontname=font,
    )
    page.insert_text(
        (40, 438),
        f"Bank: Synthetic UAE Bank  IBAN: {E1C_IBAN}",
        fontsize=9,
        fontname=font,
    )
    page.insert_text((40, 470), "[stamp]", fontsize=8, fontname=font)
    doc.save(path)
    doc.close()


def invoice_e1c_ground_truth() -> dict:
    return {
        "doc_type": "sales_invoice",
        "route": "text",
        "invoice_no": E1C_INV,
        "invoice_date": "2026-01-28",
        "issuer_name": E1C_ISSUER,
        "issuer_trn": E1C_ISSUER_TRN,
        "customer_name": E1C_CUSTOMER,
        "customer_trn": E1C_CUSTOMER_TRN,
        "currency": "AED",
        "net": 500000,
        "vat": 0,
        "gross": 500000,
        "grand_total": 500000,
        "line_description": E1C_LINE,
        "line_vat_code": "EX",
    }


def _write_image_pdf(path: Path, text: str) -> None:
    """Scan-like PDF: raster page with no text layer."""
    import fitz
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(img)
    y = 40
    for line in text.splitlines():
        draw.text((40, y), line, fill="black")
        y += 28
    # mild noise
    rnd = random.Random(42)
    px = img.load()
    for _ in range(800):
        x, yy = rnd.randint(0, img.width - 1), rnd.randint(0, img.height - 1)
        px[x, yy] = (rnd.randint(180, 255),) * 3

    buf = __import__("io").BytesIO()
    img.save(buf, format="PNG")
    png = buf.getvalue()

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, stream=png)
    doc.save(path)
    doc.close()


def _write_png(path: Path, text: str, *, seed: int = 1) -> None:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1000, 1400), "white")
    draw = ImageDraw.Draw(img)
    y = 40
    for line in text.splitlines():
        draw.text((40, y), line, fill="black")
        y += 30
    rnd = random.Random(seed)
    px = img.load()
    for _ in range(1200):
        x, yy = rnd.randint(0, img.width - 1), rnd.randint(0, img.height - 1)
        px[x, yy] = (rnd.randint(160, 255),) * 3
    img.save(path, format="PNG")


def _write_mixed_pdf(path: Path) -> None:
    import fitz
    from PIL import Image, ImageDraw

    doc = fitz.open()
    p1 = doc.new_page(width=595, height=842)
    p1.insert_text((50, 72), invoice_body(99), fontsize=11, fontname="helv")

    img = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(img)
    draw.text((40, 40), "SCANNED PAGE TWO", fill="black")
    draw.text((40, 80), "Invoice No: INV-SYN-099", fill="black")
    draw.text((40, 120), "Total                  105.00", fill="black")
    buf = __import__("io").BytesIO()
    img.save(buf, format="PNG")
    p2 = doc.new_page(width=595, height=842)
    p2.insert_image(p2.rect, stream=buf.getvalue())
    doc.save(path)
    doc.close()


def main() -> None:
    for i in range(1, 11):
        body = invoice_body(i)
        (ROOT / "text" / f"invoice_{i:02d}.txt").write_text(body, encoding="utf-8")
        _write_pdf(ROOT / "pdfs" / f"invoice_{i:02d}.pdf", body)
        gt = {
            "doc_type": "sales_invoice",
            "route": "text",
            "invoice_no": f"INV-SYN-{i:03d}",
            "invoice_date": "2026-05-15",
            "grand_total": 10500,
            "supplier_trn": "100000000000001",
        }
        (ROOT / "ground_truth" / f"invoice_{i:02d}.json").write_text(
            json.dumps(gt, indent=2) + "\n", encoding="utf-8"
        )

    for i in range(1, 6):
        body = invoice_body(i + 20)
        (ROOT / "text" / f"scan_proxy_{i:02d}.txt").write_text(
            body + "\n[scanned-proxy]\n", encoding="utf-8"
        )
        _write_png(ROOT / "scans" / f"scan_{i:02d}.png", body, seed=i)
        _write_image_pdf(ROOT / "pdfs" / f"scan_{i:02d}.pdf", body)
        gt = {
            "doc_type": "sales_invoice",
            "route": "scan",
            "invoice_no": f"INV-SYN-{i + 20:03d}",
            "invoice_date": "2026-05-15",
            "grand_total": 10500,
            "supplier_trn": "100000000000001",
        }
        (ROOT / "ground_truth" / f"scan_{i:02d}.json").write_text(
            json.dumps(gt, indent=2) + "\n", encoding="utf-8"
        )

    _write_mixed_pdf(ROOT / "pdfs" / "mixed_invoice.pdf")
    (ROOT / "ground_truth" / "mixed_invoice.json").write_text(
        json.dumps(
            {
                "doc_type": "sales_invoice",
                "route": "mixed",
                "invoice_no": "INV-SYN-099",
                "invoice_date": "2026-05-15",
                "grand_total": 10500,
                "supplier_trn": "100000000000001",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    p1, p2 = invoice_2page_bodies()
    (ROOT / "text" / "invoice_2page.txt").write_text(p1 + "\n---PAGE2---\n" + p2, encoding="utf-8")
    _write_multipage_pdf(ROOT / "pdfs" / "invoice_2page.pdf", [p1, p2])
    (ROOT / "ground_truth" / "invoice_2page.json").write_text(
        json.dumps(
            {
                "doc_type": "sales_invoice",
                "route": "text",
                "invoice_no": "INV-SYN-2PG",
                "invoice_date": "2026-05-15",
                "grand_total": 10500,
                "supplier_trn": "100000000000001",
                "gross_page": 2,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    no_vat = invoice_no_vat_body()
    (ROOT / "text" / "invoice_no_vat.txt").write_text(no_vat, encoding="utf-8")
    _write_pdf(ROOT / "pdfs" / "invoice_no_vat.pdf", no_vat)
    (ROOT / "ground_truth" / "invoice_no_vat.json").write_text(
        json.dumps(
            {
                "doc_type": "sales_invoice",
                "route": "text",
                "invoice_no": "INV-SYN-NOVAT",
                "invoice_date": "2026-05-15",
                "grand_total": 10000,
                "supplier_trn": "100000000000001",
                "vat_missing": True,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    purchase = purchase_bill_body()
    (ROOT / "text" / "purchase_bill.txt").write_text(purchase, encoding="utf-8")
    _write_pdf(ROOT / "pdfs" / "purchase_bill.pdf", purchase)
    (ROOT / "ground_truth" / "purchase_bill.json").write_text(
        json.dumps(
            {
                "doc_type": "purchase_bill",
                "route": "text",
                "invoice_no": "BILL-SYN-001",
                "invoice_date": "2026-05-15",
                "grand_total": 10500,
                "supplier_trn": "100999999999999",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    # E1c real-layout fixture (synthetic names only)
    e1c_text = invoice_e1c_layout_text()
    (ROOT / "text" / "invoice_e1c_layout.txt").write_text(e1c_text, encoding="utf-8")
    _write_e1c_layout_pdf(ROOT / "pdfs" / "invoice_e1c_layout.pdf")
    (ROOT / "ground_truth" / "invoice_e1c_layout.json").write_text(
        json.dumps(invoice_e1c_ground_truth(), indent=2) + "\n",
        encoding="utf-8",
    )

    arabic = invoice_body(77, arabic=True)
    _write_png(ROOT / "scans" / "arabic_invoice.png", arabic, seed=77)
    (ROOT / "ground_truth" / "arabic_invoice.json").write_text(
        json.dumps(
            {
                "doc_type": "sales_invoice",
                "route": "scan",
                "invoice_no": "INV-SYN-077",
                "invoice_date": "2026-05-15",
                "grand_total": 10500,
                "supplier_trn": "100000000000001",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    for name, body, gt in (
        ("bank_a", BANK_A, _bank_gt_a()),
        ("bank_b_bilingual", BANK_B, _bank_gt_b()),
        ("bank_c_multi_iban", BANK_C, _bank_gt_c()),
        ("bank_d_balance_col", BANK_D_BALANCE_COL, _bank_gt_d()),
    ):
        (ROOT / "text" / f"{name}.txt").write_text(body, encoding="utf-8")
        _write_pdf(ROOT / "pdfs" / f"{name}.pdf", body)
        (ROOT / "ground_truth" / f"{name}.json").write_text(
            json.dumps(gt, indent=2) + "\n",
            encoding="utf-8",
        )

    (ROOT / "text" / "card_statement.txt").write_text(CARD, encoding="utf-8")
    _write_pdf(ROOT / "pdfs" / "card_statement.pdf", CARD)
    (ROOT / "ground_truth" / "card_statement.json").write_text(
        json.dumps({"doc_type": "card_statement", "route": "text"}, indent=2) + "\n",
        encoding="utf-8",
    )

    (ROOT / "csv" / "stripe_balance_history.csv").write_text(STRIPE, encoding="utf-8")
    (ROOT / "ground_truth" / "stripe_balance_history.json").write_text(
        json.dumps({"doc_type": "gateway_statement", "route": "csv"}, indent=2) + "\n",
        encoding="utf-8",
    )

    print("Wrote synthetic extraction fixtures")
    print(f"  text PDFs: {len(list((ROOT / 'pdfs').glob('invoice_*.pdf')))}")
    print(f"  scans: {len(list((ROOT / 'scans').glob('scan_*.png')))}")
    print(f"  bank layouts: 4")
    print(f"  card: 1")
    print(f"  stripe csv: 1")
    print(f"  mixed pdf: 1")
    print(f"  arabic scan: 1")
    print(f"  e1c layout: 1")


if __name__ == "__main__":
    main()
