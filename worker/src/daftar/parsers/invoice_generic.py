from __future__ import annotations

import json
import re

from daftar.extraction.fields import extract_invoice_fields
from daftar.parsers.base import ParsedDocument, ParsedLine


def _pdf_pages(content: bytes) -> tuple[list[str], list[dict], list[tuple[int, str]]]:
    from daftar.extraction.pdf_words import collect_pdf_word_boxes

    word_boxes, page_texts, methods = collect_pdf_word_boxes(content)
    return page_texts, word_boxes, methods


class InvoiceGenericParser:
    name = "invoice_generic"

    def can_parse(self, filename: str, mime: str, sample: bytes) -> int:
        name = filename.lower()
        if name.endswith(".json") and (b"taxableMinor" in sample or b"invoiceNumber" in sample):
            return 90
        if "bank" in name or "statement" in name or "stripe" in name:
            return 0
        if "invoice" in name or "bill" in name or "tax" in name:
            return 50
        if mime in ("application/pdf", "text/plain") and (
            b"TAX INVOICE" in sample.upper() or b"Tax Invoice" in sample
        ):
            return 60
        return 10

    def parse(self, filename: str, mime: str, content: bytes) -> ParsedDocument:
        if filename.lower().endswith(".json"):
            data = json.loads(content.decode("utf-8"))
            taxable = int(data.get("taxableMinor") or 0)
            vat = int(data.get("vatMinor") or 0)
            raw_type = str(data.get("docType") or "sales_invoice").lower()
            if "purchase" in raw_type or "bill" in raw_type:
                doc_type = "purchase_bill"
            else:
                doc_type = "sales_invoice"
            return ParsedDocument(
                doc_type=doc_type,
                party=data.get("counterparty"),
                document_date=data.get("entryDate"),
                period_hint=data.get("entryDate"),
                currency=str(data.get("currency") or "AED"),
                lines=[
                    ParsedLine(
                        description=str(
                            data.get("description") or data.get("invoiceNumber") or "invoice"
                        ),
                        amount_minor=taxable + vat,
                        currency=str(data.get("currency") or "AED"),
                        txn_date=data.get("entryDate"),
                        reference=data.get("invoiceNumber"),
                        meta={
                            "taxableMinor": taxable,
                            "vatMinor": vat,
                            "is_disbursement": bool(data.get("isDisbursement")),
                        },
                    )
                ],
                confidence=95,
                extras=data,
            )

        is_pdf = filename.lower().endswith(".pdf") or "pdf" in (mime or "").lower()
        word_boxes: list = []
        page_texts: list[str] = []
        methods: list[tuple[int, str]] = []
        if is_pdf:
            page_texts, word_boxes, methods = _pdf_pages(content)
            text = "\n".join(page_texts)
        else:
            text = content.decode("utf-8", errors="ignore")
            page_texts = [text]

        fields = extract_invoice_fields(
            text,
            route="text",
            page_texts=page_texts,
            word_boxes=word_boxes,
        )
        grand = fields.get("gross")
        if grand is None:
            grand = fields.get("grand_total")
        invoice_no = fields.get("document_number") or fields.get("invoice_no")
        invoice_date = fields.get("document_date") or fields.get("invoice_date")
        issuer_trn = fields.get("issuer_trn") or fields.get("supplier_trn")
        issuer_name = fields.get("issuer_name")
        customer_name = fields.get("customer_name")
        customer_trn = fields.get("customer_trn")
        net = fields.get("net")
        vat = fields.get("vat")
        currency = fields.get("currency")  # None when not printed; do not invent AED

        lower = (filename + "\n" + text).lower()
        if re.search(r"\bpurchase\s+bill\b", lower) or "vendor bill" in lower:
            doc_type = "purchase_bill"
        else:
            doc_type = "sales_invoice"

        conf = 90 if invoice_no and grand is not None else 55

        description = invoice_no or filename
        for raw in text.splitlines():
            m_line = re.match(r"^([A-Za-z][^0-9\n]*?)\s+([\d,]+\.\d{2})\s*$", raw.strip())
            if not m_line:
                continue
            label = m_line.group(1).strip()
            if re.match(r"^(vat|total|grand|subtotal|net)\b", label, re.I):
                continue
            description = label
            break

        amount_minor = int(grand) if grand is not None else 0

        return ParsedDocument(
            doc_type=doc_type,
            party=customer_name or issuer_name,
            document_date=invoice_date,
            period_hint=invoice_date,
            currency=currency or "",
            lines=[
                ParsedLine(
                    description=description,
                    amount_minor=amount_minor,
                    currency=currency or "",
                    txn_date=invoice_date,
                    reference=invoice_no,
                    confidence=conf,
                    meta={
                        "taxableMinor": net,
                        "vatMinor": vat,
                    },
                )
            ],
            confidence=conf,
            ocr_used=False,
            extras={
                "invoice_no": invoice_no,
                "document_number": invoice_no,
                "invoice_date": invoice_date,
                "document_date": invoice_date,
                "supplier_trn": issuer_trn,
                "issuer_trn": issuer_trn,
                "issuer_name": issuer_name,
                "customer_name": customer_name,
                "customer_trn": customer_trn,
                "net": net,
                "vat": vat,
                "gross": grand,
                "grand_total": grand,
                "currency": currency,
                "raw_text": text[:20000],
                "page_texts": page_texts,
                "word_boxes": word_boxes,
                "page_methods": methods,
                "fields": fields.get("fields") or {},
            },
        )
