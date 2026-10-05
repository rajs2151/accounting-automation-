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
# UAE TRN: 15 digits starting with 1 (not only those starting 100…).
TRN_RE = re.compile(r"(?<!\d)1\d{14}(?!\d)")

PARSER_ALIASES = {
    "sales_invoice": "sales_invoice",
    "purchase_bill": "purchase_bill",
    "purchase_invoice": "purchase_bill",
    "PURCHASE_INVOICE": "purchase_bill",
    "SALES_INVOICE": "sales_invoice",
    "bank_statement": "bank_statement",
    "card_statement": "card_statement",
    "gateway_statement": "gateway_statement",
    "trial_balance": "trial_balance",
    "receipt": "receipt",
    "other": "other",
}


@dataclass
class Classification:
    doc_type: str | None
    confidence: float
    reasons: list[str]
    needs_user_pick: bool


def _norm_company(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip()).casefold()


def _company_on_side(text: str, *, company_trn: str | None, company_name: str | None) -> str | None:
    """Return 'issuer' | 'customer' | None based on where the company appears."""
    if not company_trn and not company_name:
        return None
    bill_pos = re.search(r"(?i)Bill\s*To|Sold\s*To|Customer", text)
    bill_at = bill_pos.start() if bill_pos else len(text)
    before = text[:bill_at]
    after = text[bill_at:]

    trn = (company_trn or "").strip()
    name = _norm_company(company_name)

    if trn and re.search(rf"\b{re.escape(trn)}\b", before):
        return "issuer"
    if trn and re.search(rf"\b{re.escape(trn)}\b", after):
        return "customer"
    if name and name in _norm_company(before):
        return "issuer"
    if name and name in _norm_company(after):
        return "customer"
    # Whole-document fallback when layout cues are missing
    blob = text
    if trn and re.search(rf"\b{re.escape(trn)}\b", blob):
        # Prefer Bill To framing: company in bill-to → purchase; else sales
        if bill_pos and trn in after:
            return "customer"
        return "issuer"
    if name and name in _norm_company(blob):
        if bill_pos and name in _norm_company(after):
            return "customer"
        return "issuer"
    return None


def classify_document(
    filename: str,
    text: str,
    parser_type: str | None = None,
    parser_conf: float = 0.0,
    *,
    company_trn: str | None = None,
    company_name: str | None = None,
) -> Classification:
    blob = f"{filename}\n{text or ''}"
    lower = blob.lower()
    reasons: list[str] = []

    def hit(doc_type: str, conf: float, reason: str) -> Classification:
        needs = conf < 0.55 or doc_type is None
        return Classification(doc_type, conf, reasons + [reason], needs)

    # Gateway / Stripe may only be obvious from the filename (CSV preset).
    if "balance_history" in lower or ("stripe" in lower and ".csv" in lower):
        return hit("gateway_statement", 0.95, "stripe_csv")
    if "trial balance" in lower or "trial_balance" in lower:
        return hit("trial_balance", 0.9, "trial_balance_keyword")
    if (
        "credit statement" in lower
        or "credit card" in lower
        or "card statement" in lower
    ):
        return hit("card_statement", 0.85, "card_keyword")

    # Bank statements: content only (IBAN / opening-closing / txn table) — not filename.
    body = text or ""
    body_lower = body.lower()
    has_iban = IBAN_RE.search(body) is not None
    has_opening = "opening balance" in body_lower or (
        "opening" in body_lower and "balance" in body_lower
    )
    has_closing = "closing balance" in body_lower
    has_txn_table = bool(
        re.search(r"(?m)^\d{1,2}/\d{1,2}/\d{4}\s+.+\s+[\d,]+\.\d{2}\s+(CR|DR)\s*$", body)
    )
    if (
        ("account statement" in body_lower and (has_iban or has_opening or has_txn_table))
        or (has_iban and has_opening and has_closing)
        or (has_iban and has_opening and has_txn_table)
        or ("iban" in body_lower and has_opening and (has_closing or has_txn_table))
    ):
        conf = 0.92 if has_iban and (has_opening or has_txn_table) else 0.8
        return hit("bank_statement", conf, "bank_content_iban_or_balances")

    looks_invoice = (
        "tax invoice" in lower
        or "tax invoice" in filename.lower()
        or re.search(r"invoice\s*no", lower) is not None
        or re.search(r"\binv-[a-z0-9-]+", lower) is not None
        or "فاتورة" in (text or "")
    )

    if looks_invoice:
        side = _company_on_side(text or "", company_trn=company_trn, company_name=company_name)
        if side == "issuer":
            return hit("sales_invoice", 0.92, "company_is_issuer")
        if side == "customer":
            return hit("purchase_bill", 0.92, "company_is_customer")
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

    if parser_type:
        normalized = str(parser_type).strip()
        mapped = PARSER_ALIASES.get(normalized) or PARSER_ALIASES.get(normalized.lower())
        if mapped in DOC_TYPES:
            conf = max(0.5, min(0.95, float(parser_conf)))
            return hit(mapped, conf, f"parser:{mapped}")

    return Classification(None, 0.3, ["no_rule_match"], True)


def user_pick(doc_type: str) -> Classification:
    if doc_type not in DOC_TYPES:
        raise ValueError("invalid_doc_type")
    return Classification(doc_type, 1.0, ["user_pick"], False)
