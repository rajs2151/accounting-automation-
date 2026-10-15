"""Queue poller plus a private unlock endpoint.

The PDF password is accepted on this socket and kept in memory for the parse.
It is not written to the database, the job payload, or the log line.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from daftar.errors import CodedError
from daftar.pipeline import connect, process_statement
from daftar.settings import load_settings
from daftar.storage import ObjectStore

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("daftar.worker")


class UnlockHandler(BaseHTTPRequestHandler):
    settings = None
    storage = None

    def do_GET(self):
        if self.path != "/health":
            self.send_response(404)
            self.end_headers()
            return
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/unlock":
            self.send_response(404)
            self.end_headers()
            return
        expected = f"Bearer {self.settings.worker_token}"
        if self.headers.get("Authorization") != expected:
            self.send_response(401)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
            statement_id = str(payload["statementId"])
            user_id = str(payload["userId"])
            password = str(payload.get("password") or "")
        except (KeyError, TypeError, ValueError, UnicodeError):
            self._json(400, {"error": "bad_request"})
            return
        finally:
            raw = b""
        if not password:
            self._json(400, {"error": "password_required"})
            return
        try:
            with connect(self.settings.worker_database_url, user_id) as conn:
                process_statement(conn, self.storage, statement_id, password)
                statement = conn.execute(
                    "SELECT status, error FROM statements WHERE id = %s",
                    (statement_id,),
                ).fetchone()
            self._json(200, {"status": statement["status"] if statement else "not_found", "error": statement["error"] if statement else "not_found"})
        except CodedError as exc:
            self._json(400, {"error": exc.code})
        except Exception:
            logger.error("unlock failed statement=%s error_type=ingest_failed", statement_id)
            self._json(500, {"error": "ingest_failed"})
        finally:
            password = ""
            payload = {}

    def _json(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args) -> None:
        logger.info("http %s", args[0] if args else fmt)


def poll(settings, storage) -> None:
    while True:
        try:
            with connect(settings.worker_database_url) as conn:
                from daftar.books_jobs import claim_books_job, recover_stuck_books_jobs, run_books_job

                recover_stuck_books_jobs(conn)
                conn.commit()

                job = conn.execute("SELECT * FROM claim_job()").fetchone()
                conn.commit()
                if job is not None and job["id"] is not None:
                    from daftar.pipeline import run_queued_job

                    run_queued_job(conn, storage, job)
                    continue

                books_job = claim_books_job(conn)
                conn.commit()
                if books_job is not None and books_job.get("id"):
                    run_books_job(conn, dict(books_job))
                    continue

                time.sleep(0.4)
        except Exception:
            logger.error("poll error_type=worker_loop")
            time.sleep(1)


def main() -> None:
    settings = load_settings()
    storage = ObjectStore(settings)
    storage.ensure_bucket()
    from daftar.bootstrap import bootstrap

    bootstrap()
    # Load OCR models at start so the first scanned bill is not +3–5 s cold.
    try:
        from daftar.ocr_engine import loaded_model_report

        report = loaded_model_report()
        logger.info("ocr_models %s", report.get("models_loaded") or report)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ocr_preload_failed: %s", exc)
    UnlockHandler.settings = settings
    UnlockHandler.storage = storage
    server = ThreadingHTTPServer(("0.0.0.0", 4711), UnlockHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    logger.info("worker listening")
    poll(settings, storage)


if __name__ == "__main__":
    main()
