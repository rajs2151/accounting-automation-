"""Field-level eval metrics for extraction (real-docs or synthetic labels).

False confidence = wrong or missing value while confidence >= HIGH_CONF.
Amounts compare as integer fils. Never logs real document content.
"""

from __future__ import annotations

from typing import Any

HIGH_CONF = 0.8

# Flat fields scored when present on the label.
INVOICE_SCALAR_FIELDS = (
    "doc_type",
    "invoice_no",
    "invoice_date",
    "due_date",
    "issuer_name",
    "issuer_trn",
    "customer_name",
    "customer_trn",
    "supplier_name",
    "supplier_trn",
    "currency",
    "net",
    "vat",
    "gross",
    "grand_total",
    "subtotal",
    "vat_total",
)

STATEMENT_SCALAR_FIELDS = (
    "doc_type",
    "bank_name",
    "iban",
    "currency",
    "period_from",
    "period_to",
    "opening_minor",
    "closing_minor",
)

AMOUNT_FIELDS = frozenset(
    {
        "net",
        "vat",
        "gross",
        "grand_total",
        "subtotal",
        "vat_total",
        "opening_minor",
        "closing_minor",
        "net_minor",
        "vat_minor",
        "debit_minor",
        "credit_minor",
        "amount_minor",
        "running_balance_minor",
    }
)


def _norm_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s if s else None


def _norm_amount(v: Any) -> int | None:
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(round(v))
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    try:
        if "." in s:
            return int(round(float(s) * 100)) if abs(float(s)) < 1e9 else int(round(float(s)))
        return int(s)
    except ValueError:
        return None


def values_equal(field: str, expected: Any, actual: Any) -> bool:
    if field in AMOUNT_FIELDS or field.endswith("_minor"):
        e = _norm_amount(expected)
        a = _norm_amount(actual)
        if e is None and a is None:
            return True
        return e is not None and a is not None and e == a
    e = _norm_str(expected)
    a = _norm_str(actual)
    if e is None and a is None:
        return True
    if e is None or a is None:
        return False
    if field.endswith("_trn") or field == "iban":
        return "".join(c for c in e if c.isalnum()).upper() == "".join(
            c for c in a if c.isalnum()
        ).upper()
    return e.casefold() == a.casefold()


def pred_value_and_conf(pred: dict[str, Any], field: str) -> tuple[Any, float]:
    """Read value + confidence from a prediction shaped like extract_invoice_fields or flat label."""
    fields_meta = pred.get("fields") if isinstance(pred.get("fields"), dict) else {}
    meta = fields_meta.get(field) if isinstance(fields_meta, dict) else None
    if isinstance(meta, dict):
        val = meta.get("value")
        conf = float(meta.get("confidence") or 0.0)
        return val, conf
    # Flat aliases used by statement parsers / labels
    aliases = {
        "grand_total": ("gross", "grand_total"),
        "subtotal": ("net", "subtotal"),
        "vat_total": ("vat", "vat_total"),
        "supplier_trn": ("issuer_trn", "supplier_trn"),
        "supplier_name": ("issuer_name", "supplier_name"),
    }
    keys = aliases.get(field, (field,))
    for k in keys:
        if k in pred and pred[k] is not None:
            return pred[k], float(pred.get("confidence") or 0.99)
    return None, 0.0


def score_field(
    field: str,
    expected: Any,
    actual: Any,
    confidence: float,
) -> dict[str, Any]:
    """Score one labeled field. Skip if expected is None (unless caller already filtered)."""
    found = actual is not None and _norm_str(actual) is not None if field not in AMOUNT_FIELDS else (
        _norm_amount(actual) is not None
    )
    if field in AMOUNT_FIELDS or field.endswith("_minor"):
        found = _norm_amount(actual) is not None
    else:
        found = _norm_str(actual) is not None

    match = values_equal(field, expected, actual)
    false_conf = (not match) and confidence >= HIGH_CONF
    return {
        "field": field,
        "match": match,
        "found": found,
        "false_confidence": false_conf,
        "confidence": confidence,
    }


def score_document(
    label: dict[str, Any],
    pred: dict[str, Any],
    *,
    scalar_fields: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    skip = set(label.get("skip_fields") or [])
    doc_type = str(label.get("doc_type") or pred.get("doc_type") or "")
    if scalar_fields is None:
        if "bank" in doc_type or "statement" in doc_type or "card" in doc_type:
            scalar_fields = STATEMENT_SCALAR_FIELDS
        else:
            scalar_fields = INVOICE_SCALAR_FIELDS

    field_results: list[dict[str, Any]] = []
    for field in scalar_fields:
        if field in skip:
            continue
        if field not in label or label[field] is None:
            continue
        actual, conf = pred_value_and_conf(pred, field)
        # Also try flat label-style keys on pred
        if actual is None and field in pred:
            actual = pred[field]
            conf = float(pred.get("confidence") or conf or 0.0)
        field_results.append(score_field(field, label[field], actual, conf))

    # Line count when both sides have lines
    line_stats = None
    lab_lines = label.get("lines")
    pred_lines = pred.get("lines") or pred.get("line_items") or []
    if isinstance(lab_lines, list) and lab_lines is not None:
        n_lab = len(lab_lines)
        n_pred = len(pred_lines) if isinstance(pred_lines, list) else 0
        line_stats = {
            "label_count": n_lab,
            "pred_count": n_pred,
            "count_match": n_lab == n_pred,
        }
        # Per-line amount checks when lengths match
        if n_lab == n_pred and n_lab:
            line_matches = 0
            for i, lab in enumerate(lab_lines):
                if not isinstance(lab, dict):
                    continue
                pl = pred_lines[i] if i < len(pred_lines) and isinstance(pred_lines[i], dict) else {}
                ok = True
                for lk in ("net_minor", "vat_minor", "debit_minor", "credit_minor", "amount_minor"):
                    if lk in lab and lab[lk] is not None:
                        if not values_equal(lk, lab[lk], pl.get(lk) if pl else None):
                            ok = False
                if "description" in lab and lab["description"] is not None:
                    if not values_equal("description", lab["description"], (pl or {}).get("description")):
                        ok = False
                if ok:
                    line_matches += 1
            line_stats["line_matches"] = line_matches

    matched = sum(1 for r in field_results if r["match"])
    found = sum(1 for r in field_results if r["found"])
    false_conf = sum(1 for r in field_results if r["false_confidence"])
    n = len(field_results)
    return {
        "layout_tag": label.get("layout_tag") or "unspecified",
        "doc_type": doc_type,
        "fields": field_results,
        "n_labeled": n,
        "n_match": matched,
        "n_found": found,
        "n_false_confidence": false_conf,
        "accuracy": (matched / n) if n else None,
        "found_rate": (found / n) if n else None,
        "false_confidence_rate": (false_conf / n) if n else None,
        "lines": line_stats,
        "page_timings_ms": pred.get("page_timings_ms") or pred.get("page_timings"),
        "elapsed_ms": pred.get("elapsed_ms"),
    }


def aggregate_scores(docs: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate per-document score dicts into overall + by layout_tag / field."""
    by_layout: dict[str, list[dict[str, Any]]] = {}
    by_field: dict[str, list[dict[str, Any]]] = {}
    for d in docs:
        tag = str(d.get("layout_tag") or "unspecified")
        by_layout.setdefault(tag, []).append(d)
        for fr in d.get("fields") or []:
            by_field.setdefault(fr["field"], []).append(fr)

    def _rollup_docs(items: list[dict[str, Any]]) -> dict[str, Any]:
        n_lab = sum(int(x.get("n_labeled") or 0) for x in items)
        n_m = sum(int(x.get("n_match") or 0) for x in items)
        n_f = sum(int(x.get("n_found") or 0) for x in items)
        n_fc = sum(int(x.get("n_false_confidence") or 0) for x in items)
        return {
            "documents": len(items),
            "n_labeled": n_lab,
            "n_match": n_m,
            "n_found": n_f,
            "n_false_confidence": n_fc,
            "accuracy": (n_m / n_lab) if n_lab else None,
            "found_rate": (n_f / n_lab) if n_lab else None,
            "false_confidence_rate": (n_fc / n_lab) if n_lab else None,
        }

    def _rollup_fields(items: list[dict[str, Any]]) -> dict[str, Any]:
        n = len(items)
        n_m = sum(1 for x in items if x.get("match"))
        n_f = sum(1 for x in items if x.get("found"))
        n_fc = sum(1 for x in items if x.get("false_confidence"))
        return {
            "n": n,
            "accuracy": (n_m / n) if n else None,
            "found_rate": (n_f / n) if n else None,
            "false_confidence_rate": (n_fc / n) if n else None,
            "n_false_confidence": n_fc,
        }

    return {
        "overall": _rollup_docs(docs),
        "by_layout_tag": {k: _rollup_docs(v) for k, v in sorted(by_layout.items())},
        "by_field": {k: _rollup_fields(v) for k, v in sorted(by_field.items())},
        "documents": len(docs),
    }


def compare_aggregates(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Any]]:
    """Before→after rows for STATUS (rates only, no field values)."""
    rows: list[dict[str, Any]] = []
    b_fields = (before.get("by_field") or {}) if isinstance(before, dict) else {}
    a_fields = (after.get("by_field") or {}) if isinstance(after, dict) else {}
    keys = sorted(set(b_fields) | set(a_fields))
    for field in keys:
        b = b_fields.get(field) or {}
        a = a_fields.get(field) or {}
        rows.append(
            {
                "field": field,
                "accuracy_before": b.get("accuracy"),
                "accuracy_after": a.get("accuracy"),
                "false_conf_before": b.get("false_confidence_rate"),
                "false_conf_after": a.get("false_confidence_rate"),
                "found_before": b.get("found_rate"),
                "found_after": a.get("found_rate"),
            }
        )
    return rows


def validate_label_schema(label: dict[str, Any]) -> list[str]:
    """Return list of schema problems (empty = ok). Fake/synthetic labels only in tests."""
    errs: list[str] = []
    if not isinstance(label, dict):
        return ["label_not_object"]
    if not label.get("doc_type"):
        errs.append("doc_type_required")
    for key in ("net", "vat", "gross", "grand_total", "opening_minor", "closing_minor"):
        if key in label and label[key] is not None:
            if _norm_amount(label[key]) is None:
                errs.append(f"{key}_not_integer_fils")
    if "lines" in label and label["lines"] is not None and not isinstance(label["lines"], list):
        errs.append("lines_not_array")
    return errs
