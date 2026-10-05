"""Ingestion pipeline shared by the worker process and the acceptance tests.

Statement text is never written to logs. Failures carry a short code only.
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
import uuid
from datetime import date

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json

from daftar.currency import declared_currency, reject_unsupported_currency
from daftar.errors import CodedError
from daftar.extract import Extraction, extract_file
from daftar.mapping import header_fingerprint, parse_date, profile_fits, propose_column_map
from daftar.money import MoneyError, parse_amount
from daftar.settings import Settings, load_settings
from daftar.sniff import sniff
from daftar.storage import ObjectStore
from daftar.textclean import clean_param
from daftar.validate import Txn, apply_validation

logger = logging.getLogger("daftar.worker")

OMAR = "55555555-5555-4555-8555-555555555555"

# Page-level OCR engines (Addendum A) collapse to document-level "ocr".
OCR_METHODS = frozenset({"ocr", "doctr", "easyocr", "tesseract"})


class AppConn:
    """App connection that sets the user for the current transaction only.

    `set_config(..., true)` is SET LOCAL. The value dies at COMMIT or ROLLBACK,
    so a pooled connection cannot keep the previous user.
    """

    def __init__(self, raw, user_id: str | None):
        self._raw = raw
        self.user_id = user_id

    def bind_user(self, user_id: str) -> None:
        self.user_id = user_id

    def execute(self, query, params=None, **kwargs):
        if self.user_id:
            self._raw.execute("SELECT set_config('app.current_user_id', %s, true)", (self.user_id,))
        # Every worker write goes through here: strip NUL/control chars so garbled PDF text never fails a job.
        return self._raw.execute(query, clean_param(params), **kwargs)

    def commit(self):
        return self._raw.commit()

    def rollback(self):
        return self._raw.rollback()

    def close(self):
        return self._raw.close()

    def transaction(self, *args, **kwargs):
        return self._raw.transaction(*args, **kwargs)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


def connect(url: str, user_id: str | None = None) -> AppConn:
    raw = psycopg.connect(url, row_factory=dict_row)
    return AppConn(raw, user_id)


def register_upload(
    conn,
    storage: ObjectStore,
    *,
    client_id: str,
    bank_account_id: str,
    uploaded_by: str,
    filename: str,
    content: bytes,
    enqueue: bool = True,
) -> dict:
    digest = hashlib.sha256(content).hexdigest()
    existing = conn.execute(
        """
        SELECT s.id AS statement_id
        FROM files f
        JOIN statements s ON s.file_id = f.id
        WHERE f.client_id = %s AND f.sha256 = %s
        ORDER BY s.created_at
        LIMIT 1
        """,
        (client_id, digest),
    ).fetchone()
    if existing:
        conn.commit()
        return {"statementId": str(existing["statement_id"]), "duplicate": True}

    kind, mime = sniff(content)
    if kind == "unknown":
        raise CodedError("unsupported_type")
    reject_unsupported_currency(declared_currency(content))
    file_id = str(uuid.uuid4())
    statement_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    key = f"clients/{client_id}/files/{file_id}"
    storage.put(key, content, mime)
    conn.execute(
        """
        INSERT INTO files (id, client_id, sha256, original_name, detected_mime, size, storage_key, uploaded_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (file_id, client_id, digest, filename, mime, len(content), key, uploaded_by),
    )
    conn.execute(
        """
        INSERT INTO statements (id, client_id, bank_account_id, file_id, currency, status)
        VALUES (%s, %s, %s, %s, 'AED', 'uploaded')
        """,
        (statement_id, client_id, bank_account_id, file_id),
    )
    if enqueue:
        conn.execute(
            """
            INSERT INTO jobs (id, client_id, statement_id, file_id, uploaded_by, kind, status)
            VALUES (%s, %s, %s, %s, %s, 'ingest', 'queued')
            """,
            (job_id, client_id, statement_id, file_id, uploaded_by),
        )
    conn.commit()
    return {"statementId": statement_id, "duplicate": False, "jobId": job_id}


def process_statement(conn, storage: ObjectStore, statement_id: str, password: str | None = None) -> None:
    """Parse one statement. `password` stays in memory and is never stored."""
    started = time.perf_counter()
    row = _load(conn, statement_id)
    conn.execute("UPDATE statements SET status = 'parsing', error = NULL WHERE id = %s", (statement_id,))
    conn.commit()
    content = storage.get(row["storage_key"])
    kind, _mime = sniff(content)
    _event(conn, row, "sniff", kind if kind != "xls" else "xlsx", 0, started)
    try:
        extraction = extract_file(content, kind, password)
    except CodedError as exc:
        if exc.code == "password_required":
            _event(conn, row, "probe", "password_required", 0, started)
            conn.execute(
                "UPDATE statements SET status = 'needs_review', error = 'password_required' WHERE id = %s",
                (statement_id,),
            )
            conn.commit()
            return
        _fail(conn, statement_id, exc.code)
        return
    try:
        reject_unsupported_currency((extraction.currency or row["currency"] or "").upper())
    except CodedError as exc:
        conn.execute(
            "UPDATE statements SET status = 'failed', error = %s WHERE id = %s",
            (exc.message, statement_id),
        )
        conn.commit()
        return
    for page_no, method in extraction.methods:
        is_ocr = method in OCR_METHODS
        event_method = "ocr" if is_ocr else method
        _event(
            conn,
            row,
            "ocr" if is_ocr else "parse",
            event_method,
            1 if is_ocr else page_no,
            started,
        )
    _store_extraction(conn, storage, row, extraction)
    column_map = propose_column_map(extraction.headers)
    fingerprint = header_fingerprint(extraction.headers)
    proposal = {
        "columnMap": column_map,
        "headers": extraction.headers,
        "dateFormat": extraction.date_format,
        "decimalSeparator": extraction.decimal_sep,
        "thousandsSeparator": extraction.thousands_sep,
        "encoding": extraction.encoding,
        "fileType": kind,
        "headerFingerprint": fingerprint,
    }
    profile = _confirmed_profile(conn, row["firm_id"], row["bank_name"], kind, fingerprint)
    use_profile = profile is not None and profile_fits(profile["column_map"], extraction.headers)
    method = _extraction_method(extraction)
    conn.execute(
        """
        UPDATE statements
        SET period_start = %s, period_end = %s, opening_minor = %s, closing_minor = %s,
            currency = %s, extraction_method = %s, page_count = %s, proposed_mapping = %s,
            extracted_row_count = %s
        WHERE id = %s
        """,
        (
            _as_date(extraction.period_start),
            _as_date(extraction.period_end),
            extraction.opening_minor,
            extraction.closing_minor,
            extraction.currency or row["currency"],
            method,
            extraction.page_count,
            Json(proposal),
            len(extraction.rows),
            statement_id,
        ),
    )
    conn.commit()
    if not use_profile:
        conn.execute(
            """
            UPDATE statements
            SET status = 'needs_review', error = 'mapping_unconfirmed'
            WHERE id = %s
            """,
            (statement_id,),
        )
        conn.commit()
        logger.info("statement=%s status=mapping_unconfirmed method=%s", statement_id, method)
        return
    _materialise(conn, row, extraction, profile["column_map"], profile["date_format"], profile["decimal_separator"], profile["thousands_separator"])


def confirm_mapping(conn, statement_id: str, user_id: str, payload: dict) -> None:
    row = _load(conn, statement_id)
    column_map = payload.get("columnMap") or {}
    date_format = payload.get("dateFormat") or "%Y-%m-%d"
    decimal_sep = payload.get("decimalSeparator") or "."
    thousands_sep = payload.get("thousandsSeparator") or ","
    mapping = row["proposed_mapping"] or {}
    file_type = mapping.get("fileType") or "csv"
    fingerprint = mapping.get("headerFingerprint") or header_fingerprint(mapping.get("headers") or [])
    version = conn.execute(
        """
        SELECT COALESCE(MAX(version), 0) + 1 AS version
        FROM parser_profiles
        WHERE firm_id = %s AND bank_name = %s AND file_type = %s AND header_fingerprint = %s
        """,
        (row["firm_id"], row["bank_name"], file_type, fingerprint),
    ).fetchone()["version"]
    encoding = mapping.get("encoding")
    conn.execute(
        """
        INSERT INTO parser_profiles
          (firm_id, bank_name, file_type, header_fingerprint, column_map, date_format, decimal_separator, thousands_separator, encoding, version, confirmed_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            row["firm_id"],
            row["bank_name"],
            file_type,
            fingerprint,
            Json(column_map),
            date_format,
            decimal_sep,
            thousands_sep,
            encoding,
            version,
            user_id,
        ),
    )
    conn.execute(
        """
        INSERT INTO audit_log (firm_id, client_id, entity, entity_id, action, actor, diff)
        VALUES (%s, %s, 'statement', %s, 'mapping_confirmed', %s, %s)
        """,
        (row["firm_id"], row["client_id"], statement_id, user_id, Json({"bankName": row["bank_name"], "version": version})),
    )
    extraction = _load_extraction(conn, statement_id)
    if row["proposed_mapping"]:
        extraction.date_format = date_format
        extraction.decimal_sep = decimal_sep
        extraction.thousands_sep = thousands_sep
    started = time.perf_counter()
    _event(conn, row, "confirm", "mapping", 0, started)
    _materialise(conn, row, extraction, column_map, date_format, decimal_sep, thousands_sep)
    conn.commit()


def _materialise(conn, row, extraction: Extraction, column_map, date_format, decimal_sep, thousands_sep) -> None:
    currency = extraction.currency or row["currency"]
    txns = _normalize(extraction, column_map, date_format, decimal_sep, thousands_sep, currency)
    statement_flags = apply_validation(
        txns,
        opening_minor=extraction.opening_minor if extraction.opening_minor is not None else row["opening_minor"],
        closing_minor=extraction.closing_minor if extraction.closing_minor is not None else row["closing_minor"],
        period_start=_as_date(extraction.period_start) or row["period_start"],
        period_end=_as_date(extraction.period_end) or row["period_end"],
        extracted_count=len(extraction.rows),
    )
    with conn.transaction():
        conn.execute("DELETE FROM bank_transactions WHERE statement_id = %s", (row["statement_id"],))
        for txn in txns:
            review = "needs_review" if txn.flags else "ok"
            conn.execute(
                """
                INSERT INTO bank_transactions (
                  client_id, statement_id, row_no, source_page, source_bbox, txn_date, value_date,
                  description_raw, description_clean, counterparty, reference, debit_minor, credit_minor,
                  balance_minor, currency, txn_type, vat_code, class_status, review_status, flags,
                  extraction_confidence, dedupe_hash
                ) VALUES (
                  %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, NULL, 'unclassified', %s, %s,
                  %s, %s
                )
                """,
                (
                    row["client_id"],
                    row["statement_id"],
                    txn.row_no,
                    txn.source_page,
                    Json(txn.source_bbox) if txn.source_bbox else None,
                    txn.txn_date,
                    txn.value_date,
                    txn.description_raw,
                    txn.description_clean,
                    txn.counterparty,
                    txn.reference,
                    txn.debit_minor,
                    txn.credit_minor,
                    txn.balance_minor,
                    currency,
                    _txn_type(txn),
                    review,
                    txn.flags,
                    txn.confidence,
                    _dedupe_hash(txn, currency),
                ),
            )
        _apply_rules(conn, row["client_id"], row["firm_id"], row["statement_id"])
        _flag_duplicates(conn, row["client_id"])
        status = "needs_review" if statement_flags or _any_review(conn, row["statement_id"]) else "parsed"
        conn.execute(
            """
            UPDATE statements
            SET status = %s, error = NULL, validation_flags = %s
            WHERE id = %s
            """,
            (status, statement_flags, row["statement_id"]),
        )
    logger.info(
        "statement=%s status=%s method=%s rows=%s",
        row["statement_id"],
        status,
        row.get("extraction_method"),
        len(txns),
    )


def _normalize(extraction: Extraction, column_map: dict, date_format: str, decimal_sep: str, thousands_sep: str, currency: str) -> list[Txn]:
    def header(field_name: str) -> str | None:
        value = column_map.get(field_name)
        return value or None

    txns: list[Txn] = []
    for row in extraction.rows:
        bad = False

        def amount(field_name: str):
            nonlocal bad
            name = header(field_name)
            if not name:
                return None
            raw = row.cells.get(name, "")
            try:
                return parse_amount(raw, decimal_sep=decimal_sep, thousands_sep=thousands_sep)
            except (MoneyError, TypeError):
                bad = True
                return None

        description_raw = row.cells.get(header("description") or "", "") if header("description") else ""
        description_clean = re.sub(r"\s+", " ", description_raw).strip()
        txns.append(
            Txn(
                row_no=row.row_no,
                txn_date=parse_date(row.cells.get(header("txn_date") or "", ""), date_format) if header("txn_date") else None,
                value_date=parse_date(row.cells.get(header("value_date") or "", ""), date_format) if header("value_date") else None,
                description_raw=description_raw,
                description_clean=description_clean,
                counterparty=(row.cells.get(header("counterparty") or "") or None) if header("counterparty") else None,
                reference=(row.cells.get(header("reference") or "") or None) if header("reference") else None,
                debit_minor=amount("debit"),
                credit_minor=amount("credit"),
                balance_minor=amount("balance"),
                confidence=row.confidence,
                source_page=row.source_page,
                source_bbox=row.source_bbox,
                bad_amount=bad,
            )
        )
    return txns


def _apply_rules(conn, client_id: str, firm_id: str, statement_id: str) -> None:
    rules = conn.execute(
        """
        SELECT id, match_type, pattern, category_id
        FROM rules
        WHERE active AND firm_id = %s AND (client_id IS NULL OR client_id = %s)
        ORDER BY priority, created_at
        """,
        (firm_id, client_id),
    ).fetchall()
    transactions = conn.execute(
        """
        SELECT id, description_raw, description_clean
        FROM bank_transactions
        WHERE statement_id = %s AND class_status = 'unclassified'
        """,
        (statement_id,),
    ).fetchall()
    for txn in transactions:
        text = txn["description_clean"] or txn["description_raw"] or ""
        for rule in rules:
            if _rule_matches(rule["match_type"], rule["pattern"], text):
                conn.execute(
                    """
                    UPDATE bank_transactions
                    SET category_id = %s, class_status = 'proposed'
                    WHERE id = %s
                    """,
                    (rule["category_id"], txn["id"]),
                )
                break


def _rule_matches(match_type: str, pattern: str, text: str) -> bool:
    if match_type == "contains":
        return pattern.casefold() in text.casefold()
    if match_type == "exact":
        return pattern.casefold() == text.casefold()
    if match_type == "regex":
        try:
            return re.search(pattern, text, re.IGNORECASE) is not None
        except re.error:
            return False
    return False


def _flag_duplicates(conn, client_id: str) -> None:
    conn.execute(
        """
        UPDATE bank_transactions AS t
        SET flags = (
              SELECT ARRAY(SELECT DISTINCT flag FROM unnest(t.flags || ARRAY['duplicate']) AS flag)
            ),
            review_status = 'needs_review'
        WHERE t.client_id = %s
          AND t.dedupe_hash IN (
            SELECT dedupe_hash FROM bank_transactions
            WHERE client_id = %s
            GROUP BY dedupe_hash
            HAVING COUNT(*) > 1
          )
        """,
        (client_id, client_id),
    )
    conn.execute(
        """
        UPDATE statements
        SET status = 'needs_review'
        WHERE client_id = %s
          AND status = 'parsed'
          AND id IN (
            SELECT DISTINCT statement_id FROM bank_transactions
            WHERE client_id = %s AND 'duplicate' = ANY(flags)
          )
        """,
        (client_id, client_id),
    )


def _any_review(conn, statement_id: str) -> bool:
    found = conn.execute(
        "SELECT 1 FROM bank_transactions WHERE statement_id = %s AND review_status = 'needs_review' LIMIT 1",
        (statement_id,),
    ).fetchone()
    return found is not None


def _store_extraction(conn, storage: ObjectStore, row, extraction: Extraction) -> None:
    conn.execute("DELETE FROM statement_extractions WHERE statement_id = %s", (row["statement_id"],))
    conn.execute("DELETE FROM statement_pages WHERE statement_id = %s", (row["statement_id"],))
    for page in extraction.pages:
        key = f"clients/{row['client_id']}/statements/{row['statement_id']}/pages/{page.page_no}.png"
        storage.put(key, page.png, "image/png")
        conn.execute(
            """
            INSERT INTO statement_pages (client_id, statement_id, page_no, storage_key, width, height)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (row["client_id"], row["statement_id"], page.page_no, key, page.width, page.height),
        )
    for item in extraction.rows:
        conn.execute(
            """
            INSERT INTO statement_extractions
              (client_id, statement_id, row_no, source_page, source_bbox, cells, confidence)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                row["client_id"],
                row["statement_id"],
                item.row_no,
                item.source_page,
                Json(item.source_bbox) if item.source_bbox else None,
                Json(item.cells),
                item.confidence,
            ),
        )
    conn.commit()


def _load_extraction(conn, statement_id: str) -> Extraction:
    parent = conn.execute(
        "SELECT opening_minor, closing_minor, period_start, period_end, currency, page_count, proposed_mapping FROM statements WHERE id = %s",
        (statement_id,),
    ).fetchone()
    rows = conn.execute(
        """
        SELECT row_no, source_page, source_bbox, cells, confidence
        FROM statement_extractions
        WHERE statement_id = %s
        ORDER BY row_no
        """,
        (statement_id,),
    ).fetchall()
    from daftar.extract import Extraction, RawRow

    proposal = parent["proposed_mapping"] or {}
    extraction = Extraction(
        headers=proposal.get("headers") or [],
        rows=[
            RawRow(
                row_no=item["row_no"],
                source_page=item["source_page"],
                source_bbox=item["source_bbox"],
                cells=item["cells"],
                confidence=float(item["confidence"]) if item["confidence"] is not None else None,
            )
            for item in rows
        ],
        opening_minor=parent["opening_minor"],
        closing_minor=parent["closing_minor"],
        period_start=parent["period_start"].isoformat() if parent["period_start"] else None,
        period_end=parent["period_end"].isoformat() if parent["period_end"] else None,
        currency=parent["currency"],
        page_count=parent["page_count"] or 1,
        decimal_sep=proposal.get("decimalSeparator") or ".",
        thousands_sep=proposal.get("thousandsSeparator") or ",",
        date_format=proposal.get("dateFormat") or "%Y-%m-%d",
    )
    return extraction


def _load(conn, statement_id: str) -> dict:
    row = conn.execute(
        """
        SELECT s.id AS statement_id, s.client_id, s.file_id, s.currency, s.opening_minor, s.closing_minor,
               s.period_start, s.period_end, s.proposed_mapping, s.extraction_method,
               f.storage_key, c.firm_id, b.bank_name
        FROM statements s
        JOIN files f ON f.id = s.file_id
        JOIN clients c ON c.id = s.client_id
        JOIN bank_accounts b ON b.id = s.bank_account_id
        WHERE s.id = %s
        """,
        (statement_id,),
    ).fetchone()
    if row is None:
        raise CodedError("not_found")
    return row


def _confirmed_profile(conn, firm_id: str, bank_name: str, file_type: str, fingerprint: str):
    return conn.execute(
        """
        SELECT column_map, date_format, decimal_separator, thousands_separator, encoding, version
        FROM parser_profiles
        WHERE firm_id = %s AND bank_name = %s AND file_type = %s AND header_fingerprint = %s
          AND confirmed_by IS NOT NULL
        ORDER BY version DESC
        LIMIT 1
        """,
        (firm_id, bank_name, file_type, fingerprint),
    ).fetchone()


def _event(conn, row, stage: str, method: str, pages: int, started: float) -> None:
    elapsed = int((time.perf_counter() - started) * 1000)
    conn.execute(
        """
        INSERT INTO processing_events
          (client_id, file_id, statement_id, stage, method, pages, est_cost_usd, duration_ms)
        VALUES (%s, %s, %s, %s, %s, %s, 0, %s)
        """,
        (row["client_id"], row["file_id"], row["statement_id"], stage, method, pages, max(elapsed, 0)),
    )
    conn.commit()


def _fail(conn, statement_id: str, code: str) -> None:
    logger.error("statement=%s error_type=%s", statement_id, code)
    conn.execute(
        "UPDATE statements SET status = 'failed', error = %s WHERE id = %s",
        (code, statement_id),
    )
    conn.commit()


def _extraction_method(extraction: Extraction) -> str:
    # Normalize Addendum A OCR engine names to the statements.extraction_method taxonomy.
    methods = {
        ("ocr" if method in OCR_METHODS else method) for _page, method in extraction.methods
    }
    if methods == {"pdf_text"}:
        return "pdf_text"
    if methods == {"ocr"}:
        return "ocr"
    if "ocr" in methods and "pdf_text" in methods:
        return "mixed"
    if "csv" in methods:
        return "csv"
    if "xlsx" in methods:
        return "xlsx"
    return "mixed" if len(methods) > 1 else (next(iter(methods)) if methods else "csv")


def _txn_type(txn: Txn) -> str:
    debit = txn.debit_minor not in (None, 0)
    credit = txn.credit_minor not in (None, 0)
    if debit and not credit:
        return "debit"
    if credit and not debit:
        return "credit"
    return "unknown"


def _dedupe_hash(txn: Txn, currency: str) -> str:
    description = " ".join((txn.description_raw or "").split()).casefold()
    payload = "|".join(
        [
            txn.txn_date.isoformat() if txn.txn_date else "",
            "" if txn.debit_minor is None else str(txn.debit_minor),
            "" if txn.credit_minor is None else str(txn.credit_minor),
            description,
            "" if txn.balance_minor is None else str(txn.balance_minor),
            currency,
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _as_date(value):
    if value is None or isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def run_queued_job(conn, storage: ObjectStore, job: dict) -> None:
    """Execute one claimed job. The password field is intentionally absent."""
    user_id = str(job["uploaded_by"])
    conn.bind_user(user_id)
    statement_id = str(job["statement_id"])
    try:
        if job["kind"] == "ingest":
            process_statement(conn, storage, statement_id, None)
        elif job["kind"] == "confirm":
            confirm_mapping(conn, statement_id, user_id, job["payload"] or {})
        else:
            raise CodedError("unknown_job")
        conn.execute("SELECT complete_job(%s, 'done', NULL)", (job["id"],))
        conn.commit()
    except Exception as exc:
        code = exc.code if isinstance(exc, CodedError) else "ingest_failed"
        logger.error("job=%s error_type=%s", job["id"], type(exc).__name__)
        try:
            conn.rollback()
        except Exception:
            pass
        conn.bind_user(user_id)
        _fail(conn, statement_id, code)
        conn.execute("SELECT complete_job(%s, 'failed', %s)", (job["id"], code))
        conn.commit()


def claim_and_run_once(settings: Settings | None = None) -> bool:
    settings = settings or load_settings()
    storage = ObjectStore(settings)
    storage.ensure_bucket()
    with connect(settings.worker_database_url) as conn:
        job = conn.execute("SELECT * FROM claim_job()").fetchone()
        conn.commit()
        if job is None or job["id"] is None:
            return False
        run_queued_job(conn, storage, job)
        return True
