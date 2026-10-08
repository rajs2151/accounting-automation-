"""Validation cross-checks (Addendum A §4). Failed checks cap confidence → Needs review."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from daftar.iban_check import is_valid_iban, normalize_iban
from daftar.extraction.fields import normalize_trn

# 1 fil per line rounding tolerance for VAT ≈ 5%.
FIL_TOLERANCE = 1
CONFIDENCE_CAP_ON_FAIL = 0.79


@dataclass
class CheckResult:
    code: str
    ok: bool
    message: str
    expected: Any = None
    got: Any = None
    field: str | None = None

    def as_flag(self) -> str:
        """Machine flag with optional expected|got for the review UI."""
        if self.ok:
            return self.code
        if self.expected is not None and self.got is not None:
            return f"{self.code}:expected={self.expected}|got={self.got}"
        return self.code


def _field_value(fields: dict[str, Any], key: str) -> Any:
    entry = fields.get(key)
    if isinstance(entry, dict) and "value" in entry:
        return entry.get("value")
    return fields.get(key)


def _set_field_confidence(fields: dict[str, Any], key: str, conf: float) -> None:
    entry = fields.get(key)
    if isinstance(entry, dict):
        entry["confidence"] = min(float(entry.get("confidence") or 1.0), conf)
        if conf < 0.8:
            entry["status"] = "low"


def check_invoice_fields(fields: dict[str, Any], *, flags: list[str] | None = None) -> list[CheckResult]:
    """Invoice math, TRN format, VAT 5% when SR evidence present."""
    results: list[CheckResult] = []
    net = _as_int(_field_value(fields, "net"))
    vat = _as_int(_field_value(fields, "vat"))
    gross = _as_int(_field_value(fields, "gross") or _field_value(fields, "grand_total"))

    line_items = _field_value(fields, "line_items") or _field_value(fields, "lines") or []
    if isinstance(line_items, dict):
        line_items = line_items.get("value") or []
    if not isinstance(line_items, list):
        line_items = []

    line_sum = 0
    for ln in line_items:
        if not isinstance(ln, dict):
            continue
        amt = ln.get("netMinor")
        if amt is None:
            amt = ln.get("amount_minor")
        if amt is not None:
            line_sum += int(amt)

    if line_items and net is not None:
        ok = abs(line_sum - net) <= FIL_TOLERANCE * max(1, len(line_items))
        results.append(
            CheckResult(
                "lines_ne_subtotal",
                ok,
                "Sum of lines does not match subtotal" if not ok else "Lines match subtotal",
                expected=net,
                got=line_sum,
                field="net",
            )
        )

    if net is not None and vat is not None and gross is not None:
        expected_gross = net + vat
        ok = abs(expected_gross - gross) <= FIL_TOLERANCE
        results.append(
            CheckResult(
                "totals_mismatch",
                ok,
                "Subtotal + VAT does not equal total" if not ok else "Totals balance",
                expected=expected_gross,
                got=gross,
                field="grand_total",
            )
        )

    # VAT ≈ 5% of net when a standard-rated line exists (never invent VAT).
    has_sr = any(
        isinstance(ln, dict) and str(ln.get("vatCode") or ln.get("vat_code") or "").upper() == "SR"
        for ln in line_items
    )
    if has_sr and net is not None and vat is not None and net != 0:
        expected_vat = (net * 5 + 50) // 100  # round half up in fils
        ok = abs(expected_vat - vat) <= FIL_TOLERANCE * max(1, len(line_items))
        results.append(
            CheckResult(
                "vat_not_5pct",
                ok,
                "VAT is not ~5% of taxable net" if not ok else "VAT ≈ 5%",
                expected=expected_vat,
                got=vat,
                field="vat",
            )
        )

    for key, label in (("issuer_trn", "Supplier TRN"), ("customer_trn", "Customer TRN"), ("supplier_trn", "Supplier TRN")):
        raw = _field_value(fields, key)
        if raw is None or raw == "":
            continue
        trn = normalize_trn(str(raw))
        ok = trn is not None and trn.startswith("100")
        results.append(
            CheckResult(
                "trn_invalid",
                ok,
                f"{label} format invalid" if not ok else f"{label} ok",
                expected="100 + 12 digits",
                got=str(raw),
                field=key,
            )
        )

    # Cap confidence on failures
    failed = [r for r in results if not r.ok]
    for r in failed:
        if r.field:
            _set_field_confidence(fields, r.field, CONFIDENCE_CAP_ON_FAIL)
            if r.field == "gross":
                _set_field_confidence(fields, "grand_total", CONFIDENCE_CAP_ON_FAIL)
            if r.field == "grand_total":
                _set_field_confidence(fields, "gross", CONFIDENCE_CAP_ON_FAIL)

    if flags is not None:
        for r in failed:
            flag = r.as_flag()
            if flag not in flags:
                flags.append(flag)

    return results


def check_statement_account(acct: dict[str, Any], *, flags: list[str] | None = None) -> list[CheckResult]:
    """Opening + credits − debits = closing; running-balance continuity; IBAN mod-97."""
    results: list[CheckResult] = []
    opening = _as_int(acct.get("opening_minor"))
    closing = _as_int(acct.get("closing_minor"))
    lines = acct.get("lines") or []
    if not isinstance(lines, list):
        lines = []

    iban = acct.get("iban")
    if iban:
        ok = is_valid_iban(str(iban))
        results.append(
            CheckResult(
                "iban_checksum_invalid",
                ok,
                "IBAN fails mod-97 check" if not ok else "IBAN checksum ok",
                expected="mod97==1",
                got=normalize_iban(str(iban)),
                field="iban",
            )
        )

    if opening is not None and closing is not None and acct.get("balances_found"):
        sum_debit = 0
        sum_credit = 0
        for ln in lines:
            if not isinstance(ln, dict):
                continue
            d = int(ln.get("debit_minor") or 0)
            c = int(ln.get("credit_minor") or 0)
            if d == 0 and c == 0:
                amt = int(ln.get("amount_minor") or 0)
                if ln.get("debit"):
                    d = amt
                else:
                    c = amt
            sum_debit += d
            sum_credit += c
        computed = opening + sum_credit - sum_debit
        ok = computed == closing
        results.append(
            CheckResult(
                "statement_balance_mismatch",
                ok,
                "Opening + credits − debits ≠ closing" if not ok else "Statement balances",
                expected=closing,
                got=computed,
                field="closing",
            )
        )

        # Running balance continuity
        if any(ln.get("running_balance_minor") is not None for ln in lines if isinstance(ln, dict)):
            prev = opening
            for idx, ln in enumerate(lines):
                if not isinstance(ln, dict):
                    continue
                d = int(ln.get("debit_minor") or 0)
                c = int(ln.get("credit_minor") or 0)
                if d == 0 and c == 0:
                    amt = int(ln.get("amount_minor") or 0)
                    if ln.get("debit"):
                        d = amt
                    else:
                        c = amt
                expected = prev + c - d
                printed = ln.get("running_balance_minor")
                if printed is None:
                    prev = expected
                    continue
                got = int(printed)
                if got != expected:
                    results.append(
                        CheckResult(
                            "running_balance_break",
                            False,
                            f"Running balance break at line {idx + 1}",
                            expected=expected,
                            got=got,
                            field="running_balance",
                        )
                    )
                    break
                prev = got

    failed = [r for r in results if not r.ok]
    if flags is not None:
        for r in failed:
            flag = r.as_flag()
            if flag not in flags:
                flags.append(flag)

    return results


def apply_invoice_checks(fields: dict[str, Any], flags: list[str]) -> list[CheckResult]:
    """Run invoice checks; mutate fields confidence + flags. Returns failed+passed results."""
    return check_invoice_fields(fields, flags=flags)


def _as_int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
