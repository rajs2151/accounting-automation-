"""Duplicate detection: file hash + type/number/party/amount (Addendum A §4)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


@dataclass
class DocIdentity:
    doc_type: str
    document_number: str | None
    party_key: str | None  # TRN or normalised name
    amount_minor: int | None


def identity_key(identity: DocIdentity) -> str | None:
    if not identity.document_number or identity.amount_minor is None:
        return None
    party = (identity.party_key or "").strip().lower()
    return f"{identity.doc_type}|{identity.document_number.strip().lower()}|{party}|{identity.amount_minor}"


def is_duplicate_identity(seen: set[str], identity: DocIdentity) -> bool:
    key = identity_key(identity)
    if key is None:
        return False
    if key in seen:
        return True
    seen.add(key)
    return False


def is_duplicate_hash(seen_hashes: set[str], content: bytes) -> tuple[bool, str]:
    digest = sha256_hex(content)
    if digest in seen_hashes:
        return True, digest
    seen_hashes.add(digest)
    return False, digest
