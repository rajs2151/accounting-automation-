"""ING-4d: invoice/statement checks + confidence cap (inline fixtures)."""

from __future__ import annotations

from daftar.extraction.checks import apply_invoice_checks, check_statement_account


def test_invoice_totals_mismatch_caps_confidence_and_flags():
    fields = {
        "net": {"value": 10000, "confidence": 0.99, "status": "ok"},
        "vat": {"value": 500, "confidence": 0.99, "status": "ok"},
        "gross": {"value": 12000, "confidence": 0.99, "status": "ok"},
        "grand_total": {"value": 12000, "confidence": 0.99, "status": "ok"},
        "line_items": {
            "value": [{"description": "Svc", "amount_minor": 10000, "netMinor": 10000, "vatCode": "SR"}],
            "confidence": 0.99,
        },
    }
    flags: list[str] = []
    results = apply_invoice_checks(fields, flags)
    assert any(not r.ok and r.code == "totals_mismatch" for r in results)
    assert any(f.startswith("totals_mismatch:expected=") for f in flags)
    assert fields["gross"]["confidence"] <= 0.79
    assert fields["gross"]["status"] == "low"


def test_invoice_lines_match_and_vat_5pct_ok():
    fields = {
        "net": {"value": 10000, "confidence": 0.99, "status": "ok"},
        "vat": {"value": 500, "confidence": 0.99, "status": "ok"},
        "gross": {"value": 10500, "confidence": 0.99, "status": "ok"},
        "line_items": {
            "value": [{"description": "Svc", "netMinor": 10000, "vatCode": "SR"}],
            "confidence": 0.99,
        },
        "issuer_trn": {"value": "100000000000003", "confidence": 0.99, "status": "ok"},
    }
    flags: list[str] = []
    results = apply_invoice_checks(fields, flags)
    assert all(r.ok for r in results)
    assert flags == []
    assert fields["gross"]["confidence"] == 0.99


def test_statement_balance_and_iban_check():
    acct = {
        "iban": "AE990331234567890123456",
        "opening_minor": 10000,
        "closing_minor": 15000,
        "balances_found": True,
        "lines": [
            {"description": "In", "debit_minor": 0, "credit_minor": 5000, "debit": False},
        ],
    }
    flags: list[str] = []
    results = check_statement_account(acct, flags=flags)
    assert any(r.code == "iban_checksum_invalid" and not r.ok for r in results)
    assert any(f.startswith("iban_checksum_invalid:expected=") for f in flags)

    ok_acct = {
        "iban": "AE070331234567890123456",
        "opening_minor": 10000,
        "closing_minor": 15000,
        "balances_found": True,
        "lines": [
            {"description": "In", "debit_minor": 0, "credit_minor": 5000, "debit": False},
        ],
    }
    flags2: list[str] = []
    results2 = check_statement_account(ok_acct, flags=flags2)
    assert all(r.ok for r in results2)
    assert flags2 == []
