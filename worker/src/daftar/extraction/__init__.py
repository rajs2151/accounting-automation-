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


def _balance_diff(opening: int, closing: int, lines: list[dict[str, Any]]) -> int:
    """opening + credits - debits - closing; 0 means balanced."""
    running = opening
    for ln in lines:
        debit = int(ln.get("debit_minor") or 0)
        credit = int(ln.get("credit_minor") or 0)
        if debit == 0 and credit == 0:
            amount = int(ln.get("amount_minor") or 0)
            if ln.get("debit"):
                debit = amount
            else:
                credit = amount
        running = running + credit - debit
    return running - closing


def _running_balance_continuity(
    opening: int, lines: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """C2 continuity: each printed balance must equal previous +/- amount.

    Returns a break dict (line index, description, expected, got, diff) or None.
    Skipped entirely when no line carries a printed running balance.
    """
    if not any(ln.get("running_balance_minor") is not None for ln in lines):
        return None
    prev = opening
    for idx, ln in enumerate(lines):
        debit = int(ln.get("debit_minor") or 0)
        credit = int(ln.get("credit_minor") or 0)
        if debit == 0 and credit == 0:
            amount = int(ln.get("amount_minor") or 0)
            if ln.get("debit"):
                debit = amount
            else:
                credit = amount
        expected = prev + credit - debit
        printed = ln.get("running_balance_minor")
        if printed is None:
            prev = expected
            continue
        got = int(printed)
        if got != expected:
            return {
                "line_index": idx,
                "description": str(ln.get("description") or ""),
                "txn_date": ln.get("txn_date"),
                "expected": expected,
                "got": got,
                "diff": got - expected,
            }
        prev = got
    return None


def _line_debit_credit(ln: dict[str, Any] | Any) -> tuple[int, int]:
    if isinstance(ln, dict):
        if "debit_minor" in ln or "credit_minor" in ln:
            return int(ln.get("debit_minor") or 0), int(ln.get("credit_minor") or 0)
        amount = int(ln.get("amount_minor") or 0)
        if ln.get("debit"):
            return amount, 0
        return 0, amount
    amount = int(getattr(ln, "amount_minor", 0) or 0)
    if getattr(ln, "debit", True):
        return amount, 0
    return 0, amount


def _stmt_line_dict(ln: Any) -> dict[str, Any]:
    if isinstance(ln, dict):
        debit, credit = _line_debit_credit(ln)
        meta = ln.get("meta") or {}
        return {
            "txn_date": ln.get("txn_date") or ln.get("line_date"),
            "description": ln.get("description") or "",
            "debit_minor": debit,
            "credit_minor": credit,
            "amount_minor": ln.get("amount_minor"),
            "debit": ln.get("debit"),
            "running_balance_minor": ln.get("running_balance_minor")
            if ln.get("running_balance_minor") is not None
            else meta.get("running_balance_minor"),
            "reference": ln.get("reference"),
            "source": ln.get("source") or meta.get("source"),
            "source_page": ln.get("source_page") or meta.get("source_page"),
            "source_bbox": ln.get("source_bbox") or meta.get("source_bbox"),
            "confidence": ln.get("confidence", 0.95),
        }
    meta = getattr(ln, "meta", None) or {}
    debit, credit = _line_debit_credit(ln)
    return {
        "txn_date": getattr(ln, "txn_date", None),
        "description": getattr(ln, "description", "") or "",
        "debit_minor": debit,
        "credit_minor": credit,
        "running_balance_minor": meta.get("running_balance_minor"),
        "reference": getattr(ln, "reference", None),
        "source": meta.get("source"),
        "source_page": meta.get("source_page"),
        "source_bbox": meta.get("source_bbox"),
        "confidence": (getattr(ln, "confidence", 100) or 100) / 100.0,
    }


def process_extract_document(conn, store: ObjectStore, payload: dict[str, Any]) -> None:
    inbox_id = payload.get("inboxItemId") or payload.get("inbox_item_id")
    file_id = payload.get("fileId") or payload.get("file_id")
    user_doc_type = (
        payload.get("userDocType")
        or payload.get("user_doc_type")
        or payload.get("intendedType")
        or payload.get("intended_type")
    )
    if not inbox_id or not file_id:
        raise ValueError("inboxItemId_and_fileId_required")
    if not user_doc_type:
        irow = conn.execute(
            "SELECT intended_type FROM books_inbox_items WHERE id = %s",
            (inbox_id,),
        ).fetchone()
        if irow and irow.get("intended_type"):
            user_doc_type = str(irow["intended_type"])

    frow = conn.execute(
        "SELECT id, client_id, storage_key, filename, content_type, sha256 FROM books_files WHERE id = %s",
        (file_id,),
    ).fetchone()
    if not frow:
        raise ValueError("file_not_found")

    content = store.get(frow["storage_key"])
    # Snippet children: clip PDF to page_start..page_end (1-based inclusive).
    page_start = payload.get("pageStart") or payload.get("page_start")
    page_end = payload.get("pageEnd") or payload.get("page_end")
    if page_start is None or page_end is None:
        irow_pages = conn.execute(
            "SELECT page_start, page_end FROM books_inbox_items WHERE id = %s",
            (inbox_id,),
        ).fetchone()
        if irow_pages:
            page_start = irow_pages.get("page_start")
            page_end = irow_pages.get("page_end")
    page_offset = 0
    if page_start is not None and page_end is not None:
        try:
            ps, pe = int(page_start), int(page_end)
            if ps >= 1 and pe >= ps:
                import fitz  # PyMuPDF

                src = fitz.open(stream=content, filetype="pdf")
                try:
                    clipped = fitz.open()
                    clipped.insert_pdf(src, from_page=ps - 1, to_page=pe - 1)
                    content = clipped.tobytes()
                    clipped.close()
                    page_offset = ps - 1
                finally:
                    src.close()
        except Exception as exc:  # noqa: BLE001
            logger.warning("snippet_pdf_clip_failed: %s", exc)

    kind, mime = sniff(content)
    parser, pconf = pick_parser(frow["filename"], frow["content_type"] or mime or "", content)

    raw_text = ""
    fields: dict[str, Any] = {}
    word_boxes: list[Any] = []
    ocr_used = False
    parsed = None
    page_methods: list[tuple[int, str]] = []
    wb_methods: list[tuple[int, str]] = []
    company_trn: str | None = None
    company_name: str | None = None
    extract_flags: list[str] = []

    # Mark extracting as soon as the worker starts — never leave the UI on Queued forever.
    conn.execute(
        """
        UPDATE books_inbox_items
        SET status = 'extracting', error = NULL, updated_at = now()
        WHERE id = %s AND status IN ('queued', 'failed', 'extracting')
        """,
        (inbox_id,),
    )

    is_pdf = kind == "pdf" or (frow["content_type"] or mime or "").startswith("application/pdf") or (
        frow["filename"] or ""
    ).lower().endswith(".pdf")

    # Text-layer word boxes (PDF points, origin top-left) for review highlights.
    if is_pdf:
        try:
            from daftar.extraction.pdf_words import collect_pdf_word_boxes

            word_boxes, page_texts_early, wb_methods = collect_pdf_word_boxes(content)
            if page_texts_early:
                raw_text = "\n".join(page_texts_early)[:20000]
            if wb_methods:
                page_methods = list(wb_methods)
        except Exception as exc:  # noqa: BLE001
            logger.warning("pdf_word_boxes_failed: %s", exc)

    if parser:
        try:
            parsed = parser.parse(frow["filename"], frow["content_type"] or "", content)
        except Exception as exc:  # noqa: BLE001
            logger.exception("parser_failed name=%s err=%s", getattr(parser, "name", "?"), exc)
            flags_early = [f"parser_error:{getattr(parser, 'name', 'unknown')}"]
            extract_flags.extend(flags_early)
            parsed = None
        if parsed is not None:
            ocr_used = bool(parsed.ocr_used)
            extras = parsed.extras or {}
            # Prefer human-readable text so classifiers see TRNs / invoice keywords.
            raw_from_parser = str(extras.get("raw_text") or "")[:20000]
            if raw_from_parser.strip():
                raw_text = raw_from_parser
            elif not raw_text.strip():
                raw_text = json.dumps(extras)[:20000]
            if extras.get("word_boxes"):
                word_boxes = list(extras["word_boxes"])
            if extras.get("page_methods"):
                page_methods = list(extras["page_methods"])

            def _line_payload(ln: Any) -> dict[str, Any]:
                meta = ln.meta or {}
                vat_code = meta.get("vat_code")
                if vat_code is None:
                    vat_code = meta.get("vatCode")
                net_minor = meta.get("netMinor")
                if net_minor is None:
                    net_minor = meta.get("net")
                if net_minor is None:
                    net_minor = ln.amount_minor
                vat_minor = meta.get("vatMinor")
                if vat_minor is None:
                    vat_minor = meta.get("vat")
                return {
                    "description": ln.description,
                    "amount_minor": ln.amount_minor,
                    "netMinor": int(net_minor) if net_minor is not None else None,
                    "vatMinor": int(vat_minor) if vat_minor is not None else None,
                    "vatCode": vat_code,  # null when no evidence — never invent SR
                    "vat_code": vat_code,
                    "qty": meta.get("qty"),
                    "rate": meta.get("rate"),
                    "confidence": ln.confidence / 100.0,
                    "source": meta.get("source"),
                }

            line_payloads = [_line_payload(ln) for ln in parsed.lines]
            fields = {
                "party": {
                    "value": parsed.party,
                    "confidence": parsed.confidence / 100.0,
                    "status": "ok" if parsed.party else "missing",
                    "source": None,
                },
                "document_date": {
                    "value": parsed.document_date,
                    "confidence": parsed.confidence / 100.0,
                    "status": "ok" if parsed.document_date else "missing",
                    "source": None,
                },
                "currency": {
                    "value": parsed.currency,
                    "confidence": 0.99,
                    "status": "ok" if parsed.currency else "missing",
                    "source": None,
                },
                "lines": {
                    "value": line_payloads,
                    "confidence": parsed.confidence / 100.0,
                },
                # Preferred by getBooksInboxReview; carries vatCode into confirm path.
                "_line_items": line_payloads,
            }
            # Merge structured invoice fields (with source page+bbox) when present.
            structured = extras.get("fields") or {}
            for key in (
                "document_number",
                "document_date",
                "issuer_name",
                "issuer_trn",
                "customer_name",
                "customer_trn",
                "currency",
                "net",
                "vat",
                "gross",
                "invoice_no",
                "invoice_date",
                "supplier_trn",
                "grand_total",
                "line_items",
            ):
                if key in structured and isinstance(structured[key], dict):
                    fields[key] = structured[key]
            # Stash until validation_flags list is built (after classify).
            extract_flags = [str(f) for f in (extras.get("flags") or []) if f]
            if ocr_used:
                for _key, field in fields.items():
                    if isinstance(field, dict) and field.get("confidence", 1) > 0.79:
                        field["confidence"] = 0.79
                        field["status"] = "low"

    # Prefer full extract.py route for PDFs/images when available (text vs OCR per page).
    is_image = kind == "image" or (frow["content_type"] or mime or "").startswith("image/")
    is_xlsx = kind in ("xlsx", "xls") or (frow["filename"] or "").lower().endswith((".xlsx", ".xls"))
    if is_pdf or is_image or is_xlsx:
        try:
            from daftar.extract import extract_file

            extract_kind = "pdf" if is_pdf else ("image" if is_image else kind)
            extraction = extract_file(content, extract_kind)
            extract_methods = list(extraction.methods or [])
            if extract_methods:
                page_methods = extract_methods
            ocr_used = ocr_used or any(m not in ("pdf_text", "csv", "xlsx") for _, m in page_methods)
            page_text = "\n".join(getattr(extraction, "raw_pages", []) or [])
            if page_text.strip():
                raw_text = (raw_text + "\n" + page_text).strip()[:20000]
            if not raw_text.strip() and extraction.rows:
                raw_text = "\n".join(
                    " ".join(str(c) for c in (r.cells if hasattr(r, "cells") else []))
                    for r in extraction.rows
                )[:20000]
            # Merge OCR / extract word boxes so scanned pages are highlightable in review.
            extra_boxes = list(getattr(extraction, "word_boxes", None) or [])
            if extra_boxes:
                from daftar.extraction.pdf_words import merge_word_boxes

                word_boxes = merge_word_boxes(word_boxes, extra_boxes)
        except Exception as exc:  # noqa: BLE001
            logger.warning("extract_file_route_failed kind=%s: %s", kind, exc)

    # Resolve company identity early so sales vs purchase uses company perspective.
    client_id_early = frow["client_id"]
    if client_id_early:
        crow_early = conn.execute(
            "SELECT trn, name FROM clients WHERE id = %s",
            (client_id_early,),
        ).fetchone()
        if crow_early:
            company_trn = crow_early.get("trn")
            company_name = crow_early.get("name")

    if user_doc_type:
        classification = user_pick(str(user_doc_type))
    else:
        classification = classify_document(
            frow["filename"],
            raw_text,
            parsed.doc_type if parsed else None,
            (parsed.confidence / 100.0) if parsed else 0.0,
            company_trn=company_trn,
            company_name=company_name,
        )

    doc_type = classification.doc_type
    class_conf = classification.confidence
    flags: list[str] = list(classification.reasons)
    for f in extract_flags:
        if f not in flags:
            flags.append(f)
    if page_methods:
        flags.append("methods:" + ",".join(f"{n}:{m}" for n, m in page_methods))
    # Pages whose text layer was unmapped-font garbage were sent to OCR; record it so review knows why.
    for n, m in wb_methods:
        if m == "text_layer_unreliable":
            flags.append(f"text_layer_unreliable:{n}")

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

    # Cross-checks (Addendum A §4): invoice math / TRN; failed → cap confidence + Needs review.
    if doc_type in {
        "sales_invoice",
        "purchase_bill",
        "credit_note",
        "debit_note",
        "receipt",
        "tax_invoice",
    } or any(k in fields for k in ("net", "gross", "grand_total", "line_items")):
        try:
            from daftar.extraction.checks import apply_invoice_checks

            apply_invoice_checks(fields, flags)
        except Exception as exc:  # noqa: BLE001
            logger.warning("invoice_checks_failed: %s", exc)

    check_failed = any(
        str(f).startswith(
            (
                "lines_ne_subtotal:expected=",
                "totals_mismatch:expected=",
                "vat_not_5pct:expected=",
                "trn_invalid:expected=",
            )
        )
        for f in flags
    )

    status = "needs_review"
    if classification.needs_user_pick or class_conf < 0.55 or doc_type is None:
        status = "needs_review"
        flags.append("low_confidence_classification")
    elif "company_mismatch" in flags or "unassigned" in flags or status_force_review:
        status = "needs_review"
    elif "duplicate_identity" in flags:
        status = "needs_review"
        flags.append("duplicate")
    elif check_failed:
        status = "needs_review"
    else:
        status = "ready" if class_conf >= 0.8 and not ocr_used else "needs_review"

    # Remap clipped word-box / field pages back to the original PDF page numbers.
    if page_offset:
        for w in word_boxes:
            if isinstance(w, dict) and "page" in w:
                try:
                    w["page"] = int(w["page"]) + page_offset
                except (TypeError, ValueError):
                    pass
        for meta in (fields.get("fields") or {}).values() if isinstance(fields.get("fields"), dict) else []:
            if not isinstance(meta, dict):
                continue
            src = meta.get("source")
            if isinstance(src, dict) and src.get("page") is not None:
                try:
                    src["page"] = int(src["page"]) + page_offset
                except (TypeError, ValueError):
                    pass

    ext_id = str(uuid4())
    conn.execute("DELETE FROM books_extractions WHERE inbox_item_id = %s", (inbox_id,))

    # Re-upload / re-extract: drop prior statement rows for this inbox item (no duplicate lines).
    prior_stmts = conn.execute(
        "SELECT id FROM books_statement_extractions WHERE inbox_item_id = %s",
        (inbox_id,),
    ).fetchall()
    for prow in prior_stmts or []:
        conn.execute("DELETE FROM books_statement_lines WHERE statement_id = %s", (prow["id"],))
    conn.execute("DELETE FROM books_statement_extractions WHERE inbox_item_id = %s", (inbox_id,))

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

    if doc_type in {"bank_statement", "card_statement", "gateway_statement"}:
        extras = (parsed.extras if parsed else None) or {}
        accounts = extras.get("accounts") if extras else None
        # Fallback: classify said bank but no parser matched (or wrong parser) — parse raw text.
        if doc_type == "bank_statement" and not accounts:
            try:
                from daftar.parsers.bank_statement_pdf import parse_bank_statement_text

                accounts = parse_bank_statement_text(raw_text, word_boxes)
            except Exception as exc:  # noqa: BLE001
                logger.warning("bank_statement_fallback_failed: %s", exc)
                accounts = None
        if not accounts and parsed:
            accounts = [
                {
                    "iban": extras.get("iban"),
                    "bank_name": parsed.party,
                    "period_from": extras.get("period_from"),
                    "period_to": extras.get("period_to"),
                    "opening_minor": extras.get("opening_minor"),
                    "closing_minor": extras.get("closing_minor"),
                    "balances_found": extras.get("opening_minor") is not None
                    and extras.get("closing_minor") is not None,
                    "has_own_activity_block": extras.get("opening_minor") is not None
                    and extras.get("closing_minor") is not None,
                    "lines": [_stmt_line_dict(ln) for ln in parsed.lines],
                    "currency": parsed.currency or "AED",
                }
            ]
        if accounts:
            from daftar.extraction.statement_account_link import (
                normalize_iban,
                resolve_statement_account_link,
            )

            # C2-2: intended account from Banking row upload (payload or inbox column).
            intended_account_id = payload.get("accountId") or payload.get("account_id")
            if not intended_account_id:
                irow = conn.execute(
                    "SELECT intended_account_id FROM books_inbox_items WHERE id = %s",
                    (inbox_id,),
                ).fetchone()
                if irow and irow.get("intended_account_id"):
                    intended_account_id = str(irow["intended_account_id"])
            intended_account_iban: str | None = None
            account_id_by_iban: dict[str, str] = {}
            if client_id:
                for arow in conn.execute(
                    """
                    SELECT id, iban FROM books_accounts
                    WHERE client_id = %s AND active = true
                      AND (
                        is_bank = true OR is_card = true OR is_gateway = true
                        OR COALESCE(sub_type, '') IN ('bank','cash','card','gateway','clearing')
                      )
                    """,
                    (client_id,),
                ).fetchall():
                    nib = normalize_iban(arow.get("iban"))
                    if nib and nib not in account_id_by_iban:
                        account_id_by_iban[nib] = str(arow["id"])
                if intended_account_id:
                    aiban = conn.execute(
                        "SELECT iban FROM books_accounts WHERE id = %s AND client_id = %s",
                        (intended_account_id, client_id),
                    ).fetchone()
                    if aiban:
                        intended_account_iban = aiban.get("iban")

            flags.append(f"statement_count:{len(accounts)}")
            for acct in accounts:
                stmt_id = str(uuid4())
                balances_found = bool(
                    acct.get("balances_found", acct.get("has_own_activity_block", False))
                )
                opening = acct.get("opening_minor")
                closing = acct.get("closing_minor")
                raw_lines = list(acct.get("lines") or [])
                acct_lines = [_stmt_line_dict(ln) for ln in raw_lines]
                stmt_flags = list(flags)
                parse_flags = [str(f) for f in (acct.get("parse_flags") or [])]
                if parse_flags:
                    stmt_flags.extend(parse_flags)
                opening_val: int | None = None
                closing_val: int | None = None
                stmt_status = "needs_review"
                attribution_ambiguous = bool(acct.get("account_attribution_ambiguous"))
                if attribution_ambiguous:
                    stmt_flags.append("account_attribution_ambiguous")

                link = resolve_statement_account_link(
                    extracted_iban=acct.get("iban"),
                    intended_account_id=str(intended_account_id) if intended_account_id else None,
                    intended_account_iban=intended_account_iban,
                    account_id_by_iban=account_id_by_iban,
                )
                linked_account_id = link.get("account_id")
                for lf in link.get("flags") or []:
                    if lf not in stmt_flags:
                        stmt_flags.append(str(lf))
                if link.get("force_needs_review"):
                    stmt_status = "needs_review"
                    if "balance_ok" in stmt_flags:
                        stmt_flags.remove("balance_ok")

                if not balances_found or opening is None or closing is None:
                    stmt_flags.append("balances_not_found")
                    # Never invent 0/0 for missing printed balances.
                    opening_val = None
                    closing_val = None
                    # Gateway CSVs (e.g. Stripe balance_history) have no opening/closing.
                    # When the Banking upload already named the account, allow ready so
                    # materialise can import lines; otherwise keep needs_review for linking.
                    if (
                        doc_type == "gateway_statement"
                        and acct_lines
                        and linked_account_id
                        and not link.get("force_needs_review")
                        and not attribution_ambiguous
                    ):
                        stmt_flags.append("gateway_no_printed_balances")
                        stmt_status = "ready"
                else:
                    opening_val = int(opening)
                    closing_val = int(closing)
                    diff = _balance_diff(opening_val, closing_val, acct_lines)
                    continuity = _running_balance_continuity(opening_val, acct_lines)
                    try:
                        from daftar.extraction.checks import check_statement_account

                        check_statement_account(acct, flags=stmt_flags)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("statement_checks_failed: %s", exc)
                    if continuity is not None:
                        stmt_flags.append("running_balance_break")
                        # sort_index (0-based) identifies the exact row; keep description too.
                        stmt_flags.append(
                            f"running_balance_break_line:{continuity['line_index']}"
                        )
                        stmt_flags.append(
                            f"running_balance_break_line:{continuity['description']}"
                        )
                        txn_date = continuity.get("txn_date")
                        if txn_date:
                            stmt_flags.append(f"running_balance_break_date:{txn_date}")
                        stmt_flags.append(f"running_balance_diff:{continuity['diff']}")
                        # expected vs read for review UI
                        stmt_flags.append(
                            f"running_balance_break:expected={continuity['expected']}|got={continuity['got']}"
                        )
                        stmt_status = "needs_review"
                    elif attribution_ambiguous:
                        # Owner decision: never ready / balance_ok while ambiguous.
                        if diff != 0:
                            stmt_flags.append("closing_mismatch")
                            stmt_flags.append(f"balance_diff:{diff}")
                            # diff = computed_closing - printed_closing
                            stmt_flags.append(
                                f"closing_mismatch:expected={closing_val}|got={closing_val + diff}"
                            )
                        stmt_status = "needs_review"
                    elif diff == 0:
                        stmt_flags.append("balance_ok")
                        stmt_status = "ready"
                    else:
                        stmt_flags.append("closing_mismatch")
                        stmt_flags.append(f"balance_diff:{diff}")
                        stmt_flags.append(
                            f"closing_mismatch:expected={closing_val}|got={closing_val + diff}"
                        )
                        stmt_status = "needs_review"

                # Parse warnings (unparsed / ambiguous columns) force review, never ready.
                if parse_flags:
                    stmt_status = "needs_review"
                    if "balance_ok" in stmt_flags:
                        stmt_flags.remove("balance_ok")

                # force_needs_review from IBAN mismatch wins over balance_ok → ready.
                if link.get("force_needs_review"):
                    stmt_status = "needs_review"
                    if "balance_ok" in stmt_flags:
                        stmt_flags.remove("balance_ok")

                conn.execute(
                    """
                    INSERT INTO books_statement_extractions (
                      id, client_id, file_id, inbox_item_id, account_id, account_label, iban, bank_name, currency,
                      period_from, period_to, opening_balance_minor, closing_balance_minor,
                      status, validation_flags
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                    """,
                    (
                        stmt_id,
                        client_id,
                        file_id,
                        inbox_id,
                        linked_account_id,
                        acct.get("bank_name"),
                        acct.get("iban"),
                        acct.get("bank_name"),
                        acct.get("currency") or (parsed.currency if parsed else None) or "AED",
                        acct.get("period_from"),
                        acct.get("period_to"),
                        opening_val,
                        closing_val,
                        stmt_status,
                        json.dumps(stmt_flags),
                    ),
                )

                # Keep every extracted line (identical same-day fees are both real).
                # Re-upload dedupe is delete-and-reinsert above — not within-statement.
                for sort_i, ln in enumerate(acct_lines):
                    debit = int(ln.get("debit_minor") or 0)
                    credit = int(ln.get("credit_minor") or 0)
                    # Printed balance only — never invent a running balance here.
                    rb = ln.get("running_balance_minor")

                    source_bbox = ln.get("source_bbox")
                    source = ln.get("source")
                    if source_bbox is None and isinstance(source, dict):
                        source_bbox = {
                            "page": source.get("page"),
                            "bbox": source.get("bbox"),
                        }
                    elif source_bbox is not None and not isinstance(source_bbox, dict):
                        source_bbox = {
                            "page": ln.get("source_page"),
                            "bbox": source_bbox,
                        }
                    elif source_bbox is None and ln.get("source_page") is not None:
                        source_bbox = {"page": ln.get("source_page"), "bbox": None}

                    conf = ln.get("confidence")
                    if conf is None:
                        conf = 0.95
                    elif isinstance(conf, int) and conf > 1:
                        conf = conf / 100.0

                    conn.execute(
                        """
                        INSERT INTO books_statement_lines (
                          statement_id, client_id, line_date, description, debit_minor, credit_minor,
                          running_balance_minor, reference, currency, source_bbox, confidence, sort_index
                        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)
                        """,
                        (
                            stmt_id,
                            client_id,
                            ln.get("txn_date"),
                            ln.get("description") or "",
                            debit,
                            credit,
                            rb,
                            ln.get("reference"),
                            acct.get("currency") or (parsed.currency if parsed else None) or "AED",
                            json.dumps(source_bbox) if source_bbox is not None else None,
                            conf,
                            sort_i,
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
