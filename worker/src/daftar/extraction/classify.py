"""Document-type classification (Addendum A §1.6). Rules first; low confidence → user picks."""

from __future__ import annotations

import re
from dataclasses import dataclass

DOC_TYPES = (
    "sales_invoice",
    "purchase_bill",
    "receipt",
    "bank_statement",
    "card_statement",
    "gateway_statement",
    "trial_balance",
    "other",
)

IBAN_RE = re.compile(r"\bAE\d{21}\b", re.I)
TRN_RE = re.compile(r"\b100\d{12}\b")


@dataclass
class Classification:
    doc_type: str | None
    confidence: float
    reasons: list[str]
    needs_user_pick: bool


def classify_document(
    filename: str,
    text: str,
    parser_type: str | None = None,
    parser_conf: float = 0.0,
) -> Classification:
    blob = f"{filename}\n{text or ''}"
    lower = blob.lower()
    reasons: list[str] = []

    def hit(doc_type: str, conf: float, reason: str) -> Classification:
        needs = conf < 0.55 or doc_type is None
        return Classification(doc_type, conf, reasons + [reason], needs)

    if "balance_history" in lower or ("stripe" in lower and ".csv" in lower):
        return hit("gateway_statement", 0.95, "stripe_csv")
    if "trial balance" in lower or "trial_balance" in lower:
        return hit("trial_balance", 0.9, "trial_balance_keyword")
    if "credit statement" in lower or "credit card" in lower or "card statement" in lower:
        return hit("card_statement", 0.85, "card_keyword")
    if (
        "account statement" in lower
        or IBAN_RE.search(blob)
        or ("iban" in lower and "opening" in lower)
    ):
        conf = 0.9 if IBAN_RE.search(blob) else 0.8
        return hit("bank_statement", conf, "bank_keyword_or_iban")
    if "tax invoice" in lower or "tax invoice" in filename.lower():
        # Sales vs purchase: if "bill to" + our customer framing → sales; "vendor"/"supplier" → purchase
        if "bill to" in lower or "sold to" in lower:
            return hit("sales_invoice", 0.88, "tax_invoice_bill_to")
        if "vendor" in lower or "supplier invoice" in lower:
            return hit("purchase_bill", 0.82, "tax_invoice_vendor")
        return hit("sales_invoice", 0.78, "tax_invoice")
    if re.search(r"\bpurchase\s+bill\b", lower) or "vendor bill" in lower:
        return hit("purchase_bill", 0.85, "purchase_bill_keyword")
    if "receipt" in lower and "invoice" not in lower:
        return hit("receipt", 0.7, "receipt_keyword")
    if "bill" in lower or "purchase" in lower:
        return hit("purchase_bill", 0.72, "bill_keyword")

    if parser_type in DOC_TYPES:
        conf = max(0.5, min(0.95, float(parser_conf)))
        return hit(parser_type, conf, f"parser:{parser_type}")

    # Ambiguous scrap — force user pick
    return Classification(None, 0.3, ["no_rule_match"], True)


def user_pick(doc_type: str) -> Classification:
    if doc_type not in DOC_TYPES:
        raise ValueError("invalid_doc_type")
    return Classification(doc_type, 1.0, ["user_pick"], False)
