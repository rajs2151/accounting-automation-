from daftar.extraction.statement_account_link import resolve_statement_account_link


def test_match_intended_iban():
    r = resolve_statement_account_link(
        extracted_iban="AE07 0331 2345 6789 0123 456",
        intended_account_id="acc-a",
        intended_account_iban="AE070331234567890123456",
    )
    assert r["account_id"] == "acc-a"
    assert r["flags"] == []
    assert r["force_needs_review"] is False


def test_iban_mismatch_blocks_intended_and_soft_links_correct():
    r = resolve_statement_account_link(
        extracted_iban="AE110331000000000000001",
        intended_account_id="acc-a",
        intended_account_iban="AE070331234567890123456",
        account_id_by_iban={"AE110331000000000000001": "acc-b"},
    )
    assert r["account_id"] == "acc-b"
    assert "iban_account_mismatch" in r["flags"]
    assert r["force_needs_review"] is True


def test_missing_file_iban_when_account_has_iban():
    r = resolve_statement_account_link(
        extracted_iban=None,
        intended_account_id="acc-a",
        intended_account_iban="AE070331234567890123456",
    )
    assert r["account_id"] is None
    assert "iban_missing_for_selected_account" in r["flags"]
