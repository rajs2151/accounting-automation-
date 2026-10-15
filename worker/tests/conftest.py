import os
import subprocess
import sys
from pathlib import Path

import psycopg
import pytest

os.environ["DATABASE_URL"] = "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test"
os.environ["DATABASE_URL_SUPER"] = "postgresql://daftar:daftar-local-only@127.0.0.1:5432/daftar_test"
os.environ["WORKER_DATABASE_URL"] = "postgresql://daftar_worker:daftar-local-only@127.0.0.1:5432/daftar_test"
os.environ.setdefault("S3_ENDPOINT", "http://127.0.0.1:59000")
os.environ.setdefault("S3_ACCESS_KEY", "daftar")
os.environ.setdefault("S3_SECRET_KEY", "daftar-local-only")
os.environ.setdefault("S3_BUCKET", "statements")
os.environ.setdefault("IBAN_ENCRYPTION_KEY", "dev-only-iban-key-change-me")
os.environ.setdefault("OCR_PROVIDER", "local")
os.environ.setdefault("PDF_PROBE_MIN_CHARS", "30")

ROOT = Path(__file__).resolve().parents[2]
OMAR = "55555555-5555-4555-8555-555555555555"
NINA = "66666666-6666-4666-8666-666666666666"
AL_NOOR = "22222222-2222-4222-8222-222222222222"
HARBOUR = "33333333-3333-4333-8333-333333333333"
NORTHWIND = "77777777-7777-4777-8777-777777777777"
OASIS = "99999999-9999-4999-8999-999999999999"


def _psql(database: str, *args: str) -> None:
    env = {**os.environ, "PGPASSWORD": "daftar-local-only"}
    subprocess.check_call(
        ["psql", "-h", "127.0.0.1", "-U", "daftar", "-d", database, "-v", "ON_ERROR_STOP=1", *args],
        env=env,
        stdout=subprocess.DEVNULL,
    )


@pytest.fixture(scope="session", autouse=True)
def migrated_database():
    if os.environ.get("PYTEST_UNIT_ONLY") == "1":
        yield
        return
    env = {**os.environ, "PGPASSWORD": "daftar-local-only"}
    subprocess.check_call(
        ["psql", "-h", "127.0.0.1", "-U", "daftar", "-d", "postgres", "-c", "SELECT 1"],
        env=env,
        stdout=subprocess.DEVNULL,
    )
    for database in ("daftar_test",):
        _psql(database, "-c", "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;")
        # Apply every numbered migration (same set as unit-inner / e2e), sorted.
        db_dir = ROOT / "db"
        for path in sorted(db_dir.glob("*.sql")):
            _psql(database, "-f", str(path))
    from daftar.bootstrap import bootstrap

    bootstrap()
    # CI installs the worker into the interpreter running pytest. A repo-local
    # .venv exists on a developer machine and is absent on GitHub-hosted runners.
    subprocess.check_call([sys.executable, str(ROOT / "fixtures" / "generate.py")])
    yield


@pytest.fixture
def ctx():
    from daftar.pipeline import connect
    from daftar.settings import load_settings
    from daftar.storage import ObjectStore

    settings = load_settings()
    with psycopg.connect(settings.database_url_super) as admin:
        admin.execute(
            """
            TRUNCATE corrections, audit_log, processing_events, bank_transactions,
                     statement_extractions, statement_pages, jobs, statements, files,
                     parser_profiles, saved_views, rules
            RESTART IDENTITY CASCADE
            """
        )
        admin.commit()
    _psql("daftar_test", "-f", str(ROOT / "db" / "02-seed.sql"))
    _psql("daftar_test", "-f", str(ROOT / "db" / "05-ledger-seed.sql"))
    _psql("daftar_test", "-f", str(ROOT / "db" / "09-close-seed.sql"))
    storage = ObjectStore(settings)
    storage.ensure_bucket()
    conn = connect(settings.database_url, OMAR)
    try:
        yield conn, storage
    finally:
        conn.close()
