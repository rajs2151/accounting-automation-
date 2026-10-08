"""ING-4a: eval metrics (inline fake labels — no real documents)."""

from __future__ import annotations

from daftar.extraction.eval_metrics import (
    aggregate_scores,
    compare_aggregates,
    score_document,
    score_field,
    validate_label_schema,
    values_equal,
)


def test_values_equal_amounts_to_the_fil():
    assert values_equal("grand_total", 10500, 10500)
    assert values_equal("grand_total", 10500, "10500")
    assert not values_equal("grand_total", 10500, 10501)


def test_trn_iban_normalize_spaces():
    assert values_equal("issuer_trn", "100000000000001", "1000 0000 0000 001")
    assert values_equal("iban", "AE070331234567890123456", "ae07 0331 2345 6789 0123 456")


def test_false_confidence_when_wrong_and_high():
    r = score_field("invoice_no", "INV-1", "INV-2", 0.95)
    assert r["match"] is False
    assert r["false_confidence"] is True
    r2 = score_field("invoice_no", "INV-1", "INV-2", 0.4)
    assert r2["false_confidence"] is False


def test_score_document_invoice_fields_meta():
    label = {
        "doc_type": "sales_invoice",
        "layout_tag": "two_column",
        "invoice_no": "INV-FAKE-001",
        "grand_total": 10500,
        "issuer_trn": "100000000000001",
    }
    pred = {
        "doc_type": "sales_invoice",
        "fields": {
            "invoice_no": {"value": "INV-FAKE-001", "confidence": 0.99},
            "grand_total": {"value": 10500, "confidence": 0.99},
            "issuer_trn": {"value": "100000000000099", "confidence": 0.9},
        },
    }
    scored = score_document(label, pred)
    assert scored["n_labeled"] == 4  # doc_type + 3
    assert scored["n_false_confidence"] == 1  # wrong TRN high conf
    assert scored["layout_tag"] == "two_column"
    assert scored["accuracy"] == 0.75


def test_aggregate_and_compare():
    d1 = score_document(
        {"doc_type": "sales_invoice", "layout_tag": "a", "invoice_no": "A"},
        {"fields": {"invoice_no": {"value": "A", "confidence": 0.99}, "doc_type": {"value": "sales_invoice", "confidence": 1}}},
    )
    # Force doc_type via flat
    d1 = score_document(
        {"doc_type": "sales_invoice", "layout_tag": "a", "invoice_no": "A"},
        {
            "doc_type": "sales_invoice",
            "fields": {"invoice_no": {"value": "A", "confidence": 0.99}},
        },
    )
    d2 = score_document(
        {"doc_type": "sales_invoice", "layout_tag": "a", "invoice_no": "B"},
        {
            "doc_type": "sales_invoice",
            "fields": {"invoice_no": {"value": "X", "confidence": 0.95}},
        },
    )
    before = aggregate_scores([d1])
    after = aggregate_scores([d1, d2])
    rows = compare_aggregates(before, after)
    assert any(r["field"] == "invoice_no" for r in rows)
    assert before["overall"]["n_false_confidence"] == 0
    assert after["overall"]["n_false_confidence"] == 1


def test_validate_label_schema():
    assert validate_label_schema({"doc_type": "sales_invoice", "grand_total": 100}) == []
    assert "doc_type_required" in validate_label_schema({})
    assert any("grand_total" in e for e in validate_label_schema({"doc_type": "x", "grand_total": "nope"}))
