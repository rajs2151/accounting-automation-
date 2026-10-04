"""Addendum A extraction pipeline for books_inbox_items → books_extractions / statement staging."""

from __future__ import annotations

import json
import logging
from typing import Any
from uuid import uuid4

from daftar.extraction.classify import classify_document, user_pick
from daftar.extraction.company_match import match_company
from daftar.extraction.dedupe import DocIdentity, identity_key, sha256_hex
from daftar.parsers.base import pick_parser
from daftar.sniff import sniff
from daftar.storage import ObjectStore

logger = logging.getLogger("daftar.extraction")

__all__ = [
    "process_extract_document",
    "sha256_hex",
    "classify_document",
    "user_pick",
    "match_company",
    "DocIdentity",
    "identity_key",
]


def process_extract_document(conn, store: ObjectStore, payload: dict[str, Any]) -> None:
    inbox_id = payload.get("inboxItemId") or payload.get("inbox_item_id")
    file_id = payload.get("fileId") or payload.get("file_id")
    user_doc_type = payload.get("userDocType") or payload.get("user_doc_type")
    if not inbox_id or not file_id:
        raise ValueError("inboxItemId_and_fileId_required")

    frow = conn.execute(
        "SELECT id, client_id, storage_key, filename, content_type, sha256 FROM books_files WHERE id = %s",
        (file_id,),
    ).fetchone()
    if not frow:
        raise ValueError("file_not_found")

    content = store.get(frow["storage_key"])
    kind, mime = sniff(content)
    parser, pconf = pick_parser(frow["filename"], frow["content_type"] or mime or "", content)
    _ = kind

    raw_text = ""
    fields: dict[str, Any] = {}
    word_boxes: list[Any] = []
    ocr_used = False
    parsed = None
    page_methods: list[tuple[int, str]] = []

    if parser:
        parsed = parser.parse(frow["filename"], frow["content_type"] or "", content)
        ocr_used = bool(parsed.ocr_used)
        raw_text = json.dumps(parsed.extras or {})[:20000]
        fields = {
            "party": {"value": parsed.party, "confidence": parsed.confidence / 100.0},
            "document_date": {"value": parsed.document_date, "confidence": parsed.confidence / 100.0},
            "currency": {"value": parsed.currency, "confidence": 0.99},
            "lines": {
                "value": [
                    {
                        "description": ln.description,
                        "amount_minor": ln.amount_minor,
                        "confidence": ln.confidence / 100.0,
                    }
                    for ln in parsed.lines
                ],
                "confidence": parsed.confidence / 100.0,
            },
        }
        if ocr_used:
            for _key, field in fields.items():
                if isinstance(field, dict) and field.get("confidence", 1) > 0.79:
                    field["confidence"] = 0.79
                    field["status"] = "low"

    # Prefer full extract.py route for PDFs/images when available (text vs OCR per page).
    if (frow["content_type"] or mime or "").startswith("application/pdf") or (
        frow["filename"] or ""
    ).lower().endswith(".pdf"):
        try:
            from daftar.extract import extract_file

            extraction = extract_file(content, "pdf")
            page_methods = list(extraction.methods or [])
            ocr_used = ocr_used or any(m != "pdf_text" for _, m in page_methods)
            raw_text = (raw_text + "\n" + "\n".join(getattr(extraction, "raw_pages", []) or []))[:20000]
            if not raw_text.strip() and extraction.rows:
                raw_text = "\n".join(
                    " ".join(str(c) for c in (r.cells if hasattr(r, "cells") else []))
                    for r in extraction.rows
                )[:20000]
        except Exception as exc:  # noqa: BLE001
            logger.warning("extract_pdf_route_failed: %s", exc)

    if user_doc_type:
        classification = user_pick(str(user_doc_type))
    else:
        classification = classify_document(
            frow["filename"],
            raw_text,
            parsed.doc_type if parsed else None,
            (parsed.confidence / 100.0) if parsed else 0.0,
        )

    doc_type = classification.doc_type
    class_conf = classification.confidence
    flags: list[str] = list(classification.reasons)
    if page_methods:
        flags.append("methods:" + ",".join(f"{n}:{m}" for n, m in page_methods))

    client_id = frow["client_id"]
    if client_id:
        crow = conn.execute(
            "SELECT trn, default_iban, name FROM clients WHERE id = %s",
            (client_id,),
        ).fetchone()
        match = match_company(
            raw_text,
            frow["filename"],
            company_trn=crow.get("trn") if crow else None,
            company_iban=crow.get("default_iban") if crow else None,
            company_name=crow.get("name") if crow else None,
        )
        flags.append(f"company_match:{match.reason}")
        if getattr(match, "label", None):
            fields["company_match"] = {
                "value": match.label,
                "confidence": 0.99 if match.reason == "trn" else 0.7,
                "status": "ok" if match.reason == "trn" else "low",
            }
        if not match.matched and match.unassigned:
            flags.append("company_mismatch")
            flags.append("unassigned")
            conn.execute(
                """
                UPDATE books_inbox_items
                SET client_id = NULL, status = 'needs_review', detected_type = %s,
                    classification_confidence = %s, updated_at = now()
                WHERE id = %s
                """,
                (doc_type, class_conf, inbox_id),
            )
            client_id = None
        elif match.needs_review:
            flags.append("company_needs_review")
            status_force_review = True
        else:
            status_force_review = False
    else:
        flags.append("unassigned")
        status_force_review = False

    # Business-key duplicate (type/number/party/amount) against prior extractions
    inv_no = None
    amount = None
    party_key = None
    if isinstance(fields.get("lines"), dict):
        lines_val = fields["lines"].get("value") or []
        if lines_val:
            amount = sum(int(x.get("amount_minor") or 0) for x in lines_val)
    extras = (parsed.extras if parsed else None) or {}
    inv_no = extras.get("invoice_no") or extras.get("document_number")
    party_key = (parsed.party if parsed else None) or extras.get("party")
    if inv_no and amount is not None and doc_type:
        key = identity_key(
            DocIdentity(doc_type, str(inv_no), str(party_key) if party_key else None, int(amount))
        )
        if key:
            prior = conn.execute(
                """
                SELECT id FROM books_extractions
                WHERE validation_flags::text LIKE %s
                LIMIT 1
                """,
                (f"%identity:{key}%",),
            ).fetchone()
            if prior:
                flags.append("duplicate_identity")
            flags.append(f"identity:{key}")

    status = "needs_review"
    if classification.needs_user_pick or class_conf < 0.55 or doc_type is None:
        status = "needs_review"
        flags.append("low_confidence_classification")
    elif "company_mismatch" in flags or "unassigned" in flags or status_force_review:
        status = "needs_review"
    elif "duplicate_identity" in flags:
        status = "needs_review"
        flags.append("duplicate")
    else:
        status = "ready" if class_conf >= 0.8 and not ocr_used else "needs_review"

    ext_id = str(uuid4())
    conn.execute("DELETE FROM books_extractions WHERE inbox_item_id = %s", (inbox_id,))
    conn.execute(
        """
        INSERT INTO books_extractions (
          id, client_id, file_id, inbox_item_id, doc_type, status,
          fields_json, raw_text, word_boxes, validation_flags, extractor_version
        ) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s::jsonb,%s::jsonb,'phase1-v1')
        """,
        (
            ext_id,
            client_id,
            file_id,
            inbox_id,
            doc_type,
            status,
            json.dumps(fields),
            raw_text,
            json.dumps(word_boxes),
            json.dumps(flags),
        ),
    )

    if doc_type in {"bank_statement", "card_statement", "gateway_statement"} and parsed:
        stmt_id = str(uuid4())
        opening = parsed.extras.get("opening_minor") if parsed.extras else None
        closing = parsed.extras.get("closing_minor") if parsed.extras else None
        conn.execute(
            """
            INSERT INTO books_statement_extractions (
              id, client_id, file_id, inbox_item_id, bank_name, currency,
              opening_balance_minor, closing_balance_minor, status, validation_flags
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
            """,
            (
                stmt_id,
                client_id,
                file_id,
                inbox_id,
                parsed.party,
                parsed.currency or "AED",
                opening,
                closing,
                "needs_review",
                json.dumps(flags),
            ),
        )
        running = opening or 0
        for i, ln in enumerate(parsed.lines):
            debit = ln.amount_minor if ln.debit else 0
            credit = 0 if ln.debit else ln.amount_minor
            running = running + credit - debit
            conn.execute(
                """
                INSERT INTO books_statement_lines (
                  statement_id, client_id, line_date, description, debit_minor, credit_minor,
                  running_balance_minor, reference, currency, confidence, sort_index
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    stmt_id,
                    client_id,
                    ln.txn_date,
                    ln.description,
                    debit,
                    credit,
                    running,
                    ln.reference,
                    ln.currency,
                    (ln.confidence or 100) / 100.0,
                    i,
                ),
            )

    conn.execute(
        """
        UPDATE books_inbox_items
        SET detected_type = %s, classification_confidence = %s, status = %s, updated_at = now()
        WHERE id = %s
        """,
        (doc_type, class_conf, status if client_id else "needs_review", inbox_id),
    )
