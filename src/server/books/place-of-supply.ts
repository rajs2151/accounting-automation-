/**
 * P2B-2: place of supply (emirate) on sales / purchase documents, for VAT 201 emirate grouping.
 * Source of truth: the party master (country + emirate), snapshotted on the document at create and
 * refreshed at approve; frozen once posted (correction = void + re-issue). A draft may carry an
 * override with a reason (audited). Credit/debit notes inherit from their original.
 */
import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export const UAE_EMIRATES = [
  "Abu Dhabi",
  "Dubai",
  "Sharjah",
  "Ajman",
  "Umm Al Quwain",
  "Ras Al Khaimah",
  "Fujairah",
] as const;
export type Emirate = (typeof UAE_EMIRATES)[number];
export type PlaceOfSupply = Emirate | "OUTSIDE_UAE";
export type PlaceOfSupplySource = "party" | "original" | "override" | "missing";

const ALIASES: Record<string, Emirate> = {
  "abu dhabi": "Abu Dhabi",
  abudhabi: "Abu Dhabi",
  auh: "Abu Dhabi",
  ad: "Abu Dhabi",
  dubai: "Dubai",
  dxb: "Dubai",
  du: "Dubai",
  sharjah: "Sharjah",
  shj: "Sharjah",
  sh: "Sharjah",
  ajman: "Ajman",
  ajm: "Ajman",
  aj: "Ajman",
  "umm al quwain": "Umm Al Quwain",
  "umm al qaiwain": "Umm Al Quwain",
  uaq: "Umm Al Quwain",
  "ras al khaimah": "Ras Al Khaimah",
  rak: "Ras Al Khaimah",
  fujairah: "Fujairah",
  fuj: "Fujairah",
  fu: "Fujairah",
};

/** Canonical emirate name for free-text input (case/spacing/common codes), else null. */
export function normalizeEmirate(input: string | null | undefined): Emirate | null {
  if (!input) return null;
  const key = input.trim().toLowerCase().replace(/[-_.]+/g, " ").replace(/\s+/g, " ");
  return ALIASES[key] ?? ALIASES[key.replace(/ /g, "")] ?? null;
}

export function normalizePlaceOfSupply(input: string | null | undefined): PlaceOfSupply | null {
  if (!input) return null;
  if (input.trim().toUpperCase().replace(/[\s-]+/g, "_") === "OUTSIDE_UAE") return "OUTSIDE_UAE";
  return normalizeEmirate(input);
}

/** Place of supply implied by a party master row. */
export function placeOfSupplyFromParty(party: {
  country?: string | null;
  emirate?: string | null;
}): { placeOfSupply: PlaceOfSupply | null; source: "party" | "missing" } {
  const country = String(party.country || "AE").toUpperCase();
  if (country !== "AE") return { placeOfSupply: "OUTSIDE_UAE", source: "party" };
  const e = normalizeEmirate(party.emirate);
  return e ? { placeOfSupply: e, source: "party" } : { placeOfSupply: null, source: "missing" };
}

/**
 * Resolve the place of supply for a (draft) document: note → original's; else party master.
 * Never overrides an explicit 'override'.
 */
export async function resolveDocumentPlaceOfSupply(
  db: PoolClient,
  clientId: string,
  args: { docType: string; partyId: string; originalDocumentId?: string | null },
): Promise<{ placeOfSupply: PlaceOfSupply | null; source: PlaceOfSupplySource }> {
  if ((args.docType === "credit_note" || args.docType === "debit_note") && args.originalDocumentId) {
    const orig = await db.query(
      `SELECT place_of_supply FROM books_documents WHERE id = $1 AND client_id = $2`,
      [args.originalDocumentId, clientId],
    );
    const pos = orig.rows[0]?.place_of_supply as PlaceOfSupply | null | undefined;
    if (pos) return { placeOfSupply: pos, source: "original" };
  }
  const party = await db.query(
    `SELECT country, emirate FROM books_parties WHERE id = $1 AND client_id = $2`,
    [args.partyId, clientId],
  );
  if (!party.rowCount) throw new BooksError("party_not_found", "not_found");
  return placeOfSupplyFromParty(party.rows[0]);
}

/** Write the resolved snapshot on a draft unless it carries an override. */
export async function refreshDraftPlaceOfSupply(db: PoolClient, clientId: string, documentId: string) {
  const doc = await db.query(
    `SELECT doc_type, party_id, original_document_id, status, place_of_supply_source
     FROM books_documents WHERE id = $1 AND client_id = $2`,
    [documentId, clientId],
  );
  if (!doc.rowCount) throw new BooksError("document_not_found", "not_found");
  const d = doc.rows[0];
  if (d.status !== "draft" || d.place_of_supply_source === "override" || !d.party_id) return;
  const r = await resolveDocumentPlaceOfSupply(db, clientId, {
    docType: String(d.doc_type),
    partyId: String(d.party_id),
    originalDocumentId: d.original_document_id ? String(d.original_document_id) : null,
  });
  await db.query(
    `UPDATE books_documents SET place_of_supply = $3, place_of_supply_source = $4,
       place_of_supply_reason = NULL
     WHERE id = $1 AND client_id = $2`,
    [documentId, clientId, r.placeOfSupply, r.source],
  );
}

/**
 * Override the place of supply on a draft (e.g. services performed in another emirate).
 * Reason required; audited with before/after. Pass placeOfSupply = null to clear the override and
 * fall back to the party master.
 */
export async function setDocumentPlaceOfSupply(
  userId: string,
  clientId: string,
  documentId: string,
  body: { placeOfSupply: string | null; reason?: string | null },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const doc = await db.query(
      `SELECT status, doc_type, place_of_supply, place_of_supply_source, place_of_supply_reason
       FROM books_documents WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [documentId, clientId],
    );
    if (!doc.rowCount) throw new BooksError("document_not_found", "not_found");
    const d = doc.rows[0];
    if (d.status !== "draft") throw new BooksError("not_draft", "conflict");
    if (!["sales_invoice", "purchase_bill", "credit_note", "debit_note"].includes(String(d.doc_type))) {
      throw new BooksError("place_of_supply_not_applicable", "invalid");
    }
    const before = {
      placeOfSupply: d.place_of_supply,
      source: d.place_of_supply_source,
      reason: d.place_of_supply_reason,
    };

    if (body.placeOfSupply == null) {
      await db.query(
        `UPDATE books_documents SET place_of_supply_source = NULL WHERE id = $1 AND client_id = $2`,
        [documentId, clientId],
      );
      await refreshDraftPlaceOfSupply(db, clientId, documentId);
    } else {
      const pos = normalizePlaceOfSupply(body.placeOfSupply);
      if (!pos) throw new BooksError("invalid_place_of_supply", "invalid");
      const reason = String(body.reason || "").trim();
      if (!reason) throw new BooksError("place_of_supply_reason_required", "invalid");
      await db.query(
        `UPDATE books_documents SET place_of_supply = $3, place_of_supply_source = 'override',
           place_of_supply_reason = $4, updated_at = now()
         WHERE id = $1 AND client_id = $2`,
        [documentId, clientId, pos, reason],
      );
    }
    const after = await db.query(
      `SELECT place_of_supply, place_of_supply_source, place_of_supply_reason
       FROM books_documents WHERE id = $1`,
      [documentId],
    );
    const out = {
      placeOfSupply: after.rows[0].place_of_supply as PlaceOfSupply | null,
      source: after.rows[0].place_of_supply_source as PlaceOfSupplySource,
      reason: after.rows[0].place_of_supply_reason as string | null,
    };
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "set_place_of_supply",
      entity: "books_document",
      entityId: documentId,
      before,
      after: out,
    });
    return { documentId, ...out };
  });
}

/**
 * Posted sales/purchase documents with no place of supply (party has no emirate) in a date range —
 * the VAT 201 readiness gap list. Approve does not block on this yet (owner decision pending).
 */
export async function listPlaceOfSupplyGaps(
  userId: string,
  clientId: string,
  opts?: { from?: string; to?: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT d.id, d.doc_type AS "docType", d.document_number AS "documentNumber",
              d.issue_date AS "issueDate", d.party_id AS "partyId", p.name AS "partyName",
              d.vat_minor AS "vatMinor"
       FROM books_documents d
       JOIN books_parties p ON p.id = d.party_id
       WHERE d.client_id = $1 AND d.status = 'posted' AND d.deleted_at IS NULL
         AND d.doc_type IN ('sales_invoice', 'purchase_bill', 'credit_note', 'debit_note')
         AND d.place_of_supply IS NULL
         AND ($2::date IS NULL OR d.issue_date >= $2::date)
         AND ($3::date IS NULL OR d.issue_date <= $3::date)
       ORDER BY d.issue_date, d.created_at`,
      [clientId, opts?.from || null, opts?.to || null],
    );
    return rows.rows.map((r) => ({ ...r, vatMinor: Number(r.vatMinor) }));
  });
}
