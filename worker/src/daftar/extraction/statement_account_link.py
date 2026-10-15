"""C2-2: resolve COA account for an extracted statement (mirrors src/lib/statement-account-link.ts)."""

from __future__ import annotations


def normalize_iban(raw: str | None) -> str:
    return "".join(ch for ch in str(raw or "") if not ch.isspace() and ch != "-").upper()


def resolve_statement_account_link(
    *,
    extracted_iban: str | None,
    intended_account_id: str | None = None,
    intended_account_iban: str | None = None,
    account_id_by_iban: dict[str, str] | None = None,
) -> dict:
    extracted = normalize_iban(extracted_iban)
    intended_id = str(intended_account_id) if intended_account_id else None
    intended_iban = normalize_iban(intended_account_iban)
    by_iban = account_id_by_iban or {}

    if intended_id:
        if not extracted:
            if not intended_iban:
                return {"account_id": intended_id, "flags": [], "force_needs_review": False}
            return {
                "account_id": None,
                "flags": ["iban_missing_for_selected_account"],
                "force_needs_review": True,
            }
        if intended_iban and extracted != intended_iban:
            correct = by_iban.get(extracted)
            account_id = correct if correct and correct != intended_id else None
            return {
                "account_id": account_id,
                "flags": ["iban_account_mismatch"],
                "force_needs_review": True,
            }
        if not intended_iban or extracted == intended_iban:
            return {"account_id": intended_id, "flags": [], "force_needs_review": False}

    if extracted:
        return {
            "account_id": by_iban.get(extracted),
            "flags": [],
            "force_needs_review": False,
        }
    return {"account_id": None, "flags": [], "force_needs_review": False}
