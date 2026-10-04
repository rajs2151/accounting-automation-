"""Process books_jobs: schedule_post, recurring_materialize, auto_reverse."""

from __future__ import annotations

import json
import logging
from datetime import date
from uuid import uuid4

logger = logging.getLogger("daftar.books_jobs")


def claim_books_job(conn):
    row = conn.execute("SELECT * FROM books_claim_job()").fetchone()
    return row


def _payload(job: dict) -> dict:
    raw = job.get("payload") or {}
    if isinstance(raw, str):
        return json.loads(raw)
    return dict(raw)


def _as_actor(conn, user_id) -> None:
    """RLS policies key off app.current_user_id (same as daftar_app sessions)."""
    if not user_id:
        raise ValueError("actor_required")
    conn.execute(
        "SELECT set_config('app.current_user_id', %s, true)",
        (str(user_id),),
    )


def _actor_from_job(conn, job: dict) -> str:
    p = _payload(job)
    actor = p.get("actorUserId") or p.get("actor_user_id") or p.get("createdBy")
    if actor:
        return str(actor)
    entry_id = p.get("entryId") or p.get("entry_id")
    template_id = p.get("templateId") or p.get("template_id")
    if entry_id:
        # SECURITY DEFINER peek so worker can resolve actor without RLS
        row = conn.execute(
            "SELECT books_job_actor(%s::uuid, NULL) AS actor",
            (entry_id,),
        ).fetchone()
        if row and row["actor"]:
            return str(row["actor"])
    if template_id:
        row = conn.execute(
            "SELECT books_job_actor(NULL, %s::uuid) AS actor",
            (template_id,),
        ).fetchone()
        if row and row["actor"]:
            return str(row["actor"])
    raise ValueError("actor_unresolved")


def run_books_job(conn, job: dict) -> None:
    kind = job["kind"]
    try:
        if kind in ("extract_document", "classify_document"):
            # Prefer uploader from books_files; fall back to Omar preparer seed.
            p = _payload(job)
            actor = p.get("actorUserId") or "55555555-5555-4555-8555-555555555555"
            file_id = p.get("fileId") or p.get("file_id")
            if file_id:
                frow = conn.execute(
                    "SELECT uploaded_by FROM books_files WHERE id = %s",
                    (file_id,),
                ).fetchone()
                if frow and frow.get("uploaded_by"):
                    actor = str(frow["uploaded_by"])
            _as_actor(conn, actor)
            _extract_document(conn, job)
        else:
            actor = _actor_from_job(conn, job)
            _as_actor(conn, actor)
            if kind == "schedule_post":
                _schedule_post(conn, job)
            elif kind == "recurring_materialize":
                _recurring_materialize(conn, job)
            elif kind == "auto_reverse":
                _auto_reverse(conn, job)
            elif kind == "deferred_release":
                _deferred_release(conn, job)
            else:
                raise ValueError(f"unknown_books_job:{kind}")
        conn.execute(
            "SELECT books_complete_job(%s::uuid, 'done', NULL)",
            (job["id"],),
        )
        conn.commit()
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        conn.execute(
            "SELECT books_complete_job(%s::uuid, 'failed', %s)",
            (job["id"], str(exc)[:500]),
        )
        conn.commit()
        logger.error("books_job failed id=%s kind=%s err=%s", job["id"], kind, exc)


def _schedule_post(conn, job: dict) -> None:
    p = _payload(job)
    entry_id = p.get("entryId") or p.get("entry_id")
    if not entry_id:
        raise ValueError("entryId_required")
    row = conn.execute(
        """
        SELECT e.id, e.client_id, e.entry_date, e.status, e.auto_reverse_next_period,
               e.created_by, e.period_id, p.status AS period_status
        FROM books_journal_entries e
        JOIN books_periods p ON p.id = e.period_id
        WHERE e.id = %s
        """,
        (entry_id,),
    ).fetchone()
    if not row:
        raise ValueError("entry_not_found")
    if row["status"] not in ("scheduled", "draft"):
        return
    if row["period_status"] == "LOCKED":
        conn.execute(
            "UPDATE books_journal_entries SET status = 'blocked' WHERE id = %s",
            (entry_id,),
        )
        return
    year = int(str(row["entry_date"])[:4])
    entry_no = conn.execute(
        "SELECT books_next_entry_no(%s::uuid, %s::int) AS n",
        (row["client_id"], year),
    ).fetchone()["n"]
    conn.execute(
        """
        UPDATE books_journal_entries
        SET status = 'posted', posted_at = now(), entry_no = COALESCE(entry_no, %s)
        WHERE id = %s AND status IN ('scheduled', 'draft')
        """,
        (entry_no, entry_id),
    )
    if row["auto_reverse_next_period"] or p.get("autoReverseNextPeriod"):
        d = row["entry_date"]
        if isinstance(d, str):
            d = date.fromisoformat(d[:10])
        if d.month == 12:
            run_on = date(d.year + 1, 1, 1)
        else:
            run_on = date(d.year, d.month + 1, 1)
        conn.execute(
            """
            INSERT INTO books_jobs (client_id, kind, status, payload, run_at)
            VALUES (%s, 'auto_reverse', 'queued', %s::jsonb, %s)
            """,
            (
                row["client_id"],
                json.dumps(
                    {
                        "entryId": str(entry_id),
                        "actorUserId": str(row["created_by"]),
                    }
                ),
                run_on.isoformat(),
            ),
        )


def _recurring_materialize(conn, job: dict) -> None:
    p = _payload(job)
    template_id = p.get("templateId") or p.get("template_id")
    tmpl = conn.execute(
        "SELECT * FROM books_recurring_templates WHERE id = %s AND active = true",
        (template_id,),
    ).fetchone()
    if not tmpl:
        return
    if tmpl["remaining"] <= 0:
        conn.execute(
            "UPDATE books_recurring_templates SET active = false WHERE id = %s",
            (template_id,),
        )
        return
    lines = tmpl["line_payload"]
    if isinstance(lines, str):
        lines = json.loads(lines)
    entry_id = str(uuid4())
    conn.execute(
        """
        INSERT INTO books_journal_entries (
          id, client_id, period_id, memo, entry_date, status, entry_type,
          content_hash, created_by, recurring_id, template_key
        ) VALUES (%s,%s,%s,%s,%s,'draft','auto',%s,%s,%s,'recurring')
        """,
        (
            entry_id,
            tmpl["client_id"],
            tmpl["period_id"],
            tmpl["memo"],
            tmpl["next_date"],
            f"recurring-{entry_id}",
            tmpl["created_by"],
            template_id,
        ),
    )
    for line in lines:
        conn.execute(
            """
            INSERT INTO books_journal_lines (
              entry_id, client_id, account_id, debit_minor, credit_minor,
              currency, aed_minor, line_memo, vat_code, tags
            ) VALUES (%s,%s,%s,%s,%s,'AED',%s,%s,%s,%s)
            """,
            (
                entry_id,
                tmpl["client_id"],
                line["accountId"],
                int(line.get("debitMinor") or 0),
                int(line.get("creditMinor") or 0),
                int(line.get("debitMinor") or 0) + int(line.get("creditMinor") or 0),
                line.get("lineMemo") or "",
                line.get("vatCode"),
                line.get("tags") or [],
            ),
        )
    year = int(str(tmpl["next_date"])[:4])
    entry_no = conn.execute(
        "SELECT books_next_entry_no(%s::uuid, %s::int) AS n",
        (tmpl["client_id"], year),
    ).fetchone()["n"]
    conn.execute(
        """
        UPDATE books_journal_entries
        SET status = 'posted', posted_at = now(), entry_no = %s
        WHERE id = %s
        """,
        (entry_no, entry_id),
    )
    freq = tmpl["frequency"]
    d = tmpl["next_date"]
    if isinstance(d, str):
        d = date.fromisoformat(d[:10])
    if freq == "monthly":
        month = d.month + 1
        year = d.year + (1 if month > 12 else 0)
        month = 1 if month > 12 else month
        nxt = date(year, month, min(d.day, 28))
    elif freq == "quarterly":
        month = d.month + 3
        year = d.year + ((month - 1) // 12)
        month = ((month - 1) % 12) + 1
        nxt = date(year, month, min(d.day, 28))
    else:
        nxt = date(d.year + 1, d.month, min(d.day, 28))
    remaining = int(tmpl["remaining"]) - 1
    conn.execute(
        """
        UPDATE books_recurring_templates
        SET next_date = %s, remaining = %s, active = %s
        WHERE id = %s
        """,
        (nxt, remaining, remaining > 0, template_id),
    )
    if remaining > 0:
        conn.execute(
            """
            INSERT INTO books_jobs (client_id, kind, status, payload, run_at)
            VALUES (%s, 'recurring_materialize', 'queued', %s::jsonb, %s)
            """,
            (
                tmpl["client_id"],
                json.dumps(
                    {
                        "templateId": str(template_id),
                        "actorUserId": str(tmpl["created_by"]),
                    }
                ),
                nxt.isoformat(),
            ),
        )


def _auto_reverse(conn, job: dict) -> None:
    p = _payload(job)
    entry_id = p.get("entryId") or p.get("entry_id")
    orig = conn.execute(
        "SELECT * FROM books_journal_entries WHERE id = %s AND status = 'posted'",
        (entry_id,),
    ).fetchone()
    if not orig:
        return
    rev_id = str(uuid4())
    today = date.today()
    conn.execute(
        """
        INSERT INTO books_journal_entries (
          id, client_id, period_id, memo, entry_date, status, reverses_entry_id,
          entry_type, content_hash, created_by
        ) VALUES (%s,%s,%s,%s,%s,'draft',%s,'reversal',%s,%s)
        """,
        (
            rev_id,
            orig["client_id"],
            orig["period_id"],
            f"Auto-reversal of {orig.get('entry_no') or entry_id}",
            today,
            entry_id,
            f"auto-rev-{rev_id}",
            orig["created_by"],
        ),
    )
    lines = conn.execute(
        "SELECT * FROM books_journal_lines WHERE entry_id = %s ORDER BY id",
        (entry_id,),
    ).fetchall()
    for line in lines:
        conn.execute(
            """
            INSERT INTO books_journal_lines (
              entry_id, client_id, account_id, debit_minor, credit_minor,
              currency, aed_minor, line_memo, vat_treatment, vat_code, tags
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            (
                rev_id,
                line["client_id"],
                line["account_id"],
                line["credit_minor"],
                line["debit_minor"],
                line["currency"],
                line["aed_minor"],
                f"Reversal: {line.get('line_memo') or ''}",
                line.get("vat_treatment"),
                line.get("vat_code"),
                line.get("tags") or [],
            ),
        )
    year = today.year
    entry_no = conn.execute(
        "SELECT books_next_entry_no(%s::uuid, %s::int) AS n",
        (orig["client_id"], year),
    ).fetchone()["n"]
    conn.execute(
        """
        UPDATE books_journal_entries
        SET status = 'posted', posted_at = now(), entry_no = %s
        WHERE id = %s
        """,
        (entry_no, rev_id),
    )
    conn.execute(
        """
        UPDATE books_journal_entries
        SET status = 'reversed', reversed_by_entry_id = %s
        WHERE id = %s
        """,
        (rev_id, entry_id),
    )

def _extract_document(conn, job: dict) -> None:
    from daftar.extraction import process_extract_document
    from daftar.settings import load_settings
    from daftar.storage import ObjectStore

    settings = load_settings()
    store = ObjectStore(settings)
    process_extract_document(conn, store, _payload(job))


def _deferred_release(conn, job: dict) -> None:
    """Release deferred revenue: Dr 2310 / Cr revenue for a schedule row."""
    p = _payload(job)
    schedule_id = p.get("scheduleId") or p.get("schedule_id")
    if not schedule_id:
        raise ValueError("scheduleId_required")
    sched = conn.execute(
        """
        SELECT s.*, p.status AS period_status
        FROM books_deferred_schedules s
        LEFT JOIN books_periods p ON p.id = s.period_id
        WHERE s.id = %s
        """,
        (schedule_id,),
    ).fetchone()
    if not sched:
        raise ValueError("schedule_not_found")
    if sched["status"] != "pending":
        return
    if sched.get("period_status") == "LOCKED":
        conn.execute(
            "UPDATE books_deferred_schedules SET status = 'blocked' WHERE id = %s",
            (schedule_id,),
        )
        return
    deferred = conn.execute(
        "SELECT id FROM books_accounts WHERE client_id = %s AND code = '2310'",
        (sched["client_id"],),
    ).fetchone()
    if not deferred:
        raise ValueError("deferred_account_missing")
    amount = int(sched["amount_aed_minor"])
    entry_id = str(uuid4())
    period_id = sched["period_id"]
    actor = _actor_from_job(conn, job)
    conn.execute(
        """
        INSERT INTO books_journal_entries (
          id, client_id, period_id, memo, entry_date, status, content_hash,
          created_by, voucher_type
        ) VALUES (%s,%s,%s,%s,%s,'draft',%s,%s,'Journal')
        """,
        (
            entry_id,
            sched["client_id"],
            period_id,
            "Deferred revenue release",
            sched["release_date"],
            "deferred-release",
            actor,
        ),
    )
    conn.execute(
        """
        INSERT INTO books_journal_lines (
          entry_id, client_id, account_id, debit_minor, credit_minor, currency, aed_minor, line_memo
        ) VALUES
          (%s,%s,%s,%s,0,'AED',%s,'Release deferred'),
          (%s,%s,%s,0,%s,'AED',%s,'Recognize revenue')
        """,
        (
            entry_id,
            sched["client_id"],
            deferred["id"],
            amount,
            amount,
            entry_id,
            sched["client_id"],
            sched["revenue_account_id"],
            amount,
            amount,
        ),
    )
    year = int(str(sched["release_date"])[:4])
    entry_no = conn.execute(
        "SELECT books_next_voucher_no(%s::uuid, 'Journal', %s::int) AS n",
        (sched["client_id"], year),
    ).fetchone()["n"]
    conn.execute(
        """
        UPDATE books_journal_entries
        SET status = 'posted', posted_at = now(), entry_no = %s
        WHERE id = %s
        """,
        (entry_no, entry_id),
    )
    conn.execute(
        """
        UPDATE books_deferred_schedules
        SET status = 'posted', journal_entry_id = %s WHERE id = %s
        """,
        (entry_id, schedule_id),
    )
