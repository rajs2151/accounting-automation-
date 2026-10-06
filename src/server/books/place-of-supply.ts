/**
 * P2B-2 / P2B-5: place of supply (emirate) on sales / purchase documents, for VAT 201 emirate grouping.
 * Decided by decidePlaceOfSupply (supply type + company establishment emirate + party master),
 * snapshotted on the document at create and refreshed at approve; frozen once posted except via the
 * audited admin re-apply. A draft may carry an override with a reason (audited). Credit/debit notes
 * inherit from their original.
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
export type PlaceOfSupplySource =
  | "party"
  | "company"
  | "original"
  | "override"
  | "missing"
  | "not_applicable";

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

/** Place of supply implied by a party master row (foreign party → OUTSIDE_UAE). */
export function placeOfSupplyFromParty(party: {
  country?: string | null;
  emirate?: string | null;
}): { placeOfSupply: PlaceOfSupply | null; source: "party" | "missing" } {
  const country = String(party.country || "AE").toUpperCase();
  if (country !== "AE") return { placeOfSupply: "OUTSIDE_UAE", source: "party" };
  const e = normalizeEmirate(party.emirate);
  return e ? { placeOfSupply: e, source: "party" } : { placeOfSupply: null, source: "missing" };
}

export type SupplyType = "goods" | "services";
export type DocumentSupplyType = SupplyType | "mixed" | "none";

/**
 * Goods vs services for one document line. Disbursements (pass-through, no VAT) are not a supply.
 * Goods: inventory / asset lines, or revenue posted to a product-sales account (sub_type 'product').
 */
export function lineSupplyType(
  lineKind: string | null | undefined,
  accountSubType?: string | null,
): SupplyType | null {
  if (lineKind === "disbursement") return null;
  if (lineKind === "inventory" || lineKind === "asset") return "goods";
  if (accountSubType === "product") return "goods";
  return "services";
}

export function documentSupplyType(lines: Array<SupplyType | null>): DocumentSupplyType {
  const kinds = new Set(lines.filter((l): l is SupplyType => l != null));
  if (kinds.size === 0) return "none";
  if (kinds.size > 1) return "mixed";
  return [...kinds][0];
}

/**
 * THE place-of-supply rule (owner decision 2026-10-06; to be confirmed with a tax adviser — change
 * it here only). Services → emirate of the supplier's establishment; goods → emirate of delivery.
 *   sales:     services → company establishment emirate; goods → customer (party) emirate.
 *   purchases: services → supplier (party) emirate;      goods → delivered to us → company emirate.
 * Foreign counterparty: party-side answers become OUTSIDE_UAE. Mixed goods + services documents
 * have no single answer → missing (gap; set an override). No VAT-able lines → not_applicable.
 */
export function decidePlaceOfSupply(args: {
  side: "sales" | "purchases";
  supplyType: DocumentSupplyType;
  companyEmirate: string | null | undefined;
  party: { country?: string | null; emirate?: string | null };
}): { placeOfSupply: PlaceOfSupply | null; source: PlaceOfSupplySource } {
  if (args.supplyType === "none") return { placeOfSupply: null, source: "not_applicable" };
  if (args.supplyType === "mixed") return { placeOfSupply: null, source: "missing" };
  const useCompany =
    (args.side === "sales" && args.supplyType === "services") ||
    (args.side === "purchases" && args.supplyType === "goods");
  if (useCompany) {
    const e = normalizeEmirate(args.companyEmirate);
    return e ? { placeOfSupply: e, source: "company" } : { placeOfSupply: null, source: "missing" };
  }
  return placeOfSupplyFromParty(args.party);
}

/**
 * Resolve the place of supply for a document: a note inherits its original's; otherwise the rule
 * above from its lines, the company and the party. Never applied over an explicit 'override'.
 */
export async function resolveDocumentPlaceOfSupply(
  db: PoolClient,
  clientId: string,
  documentId: string,
): Promise<{
  placeOfSupply: PlaceOfSupply | null;
  source: PlaceOfSupplySource;
  supplyType: DocumentSupplyType;
}> {
  const doc = await db.query(
    `SELECT d.doc_type, d.party_id, d.original_document_id, c.establishment_emirate,
            p.country, p.emirate
     FROM books_documents d
     JOIN clients c ON c.id = d.client_id
     LEFT JOIN books_parties p ON p.id = d.party_id
     WHERE d.id = $1 AND d.client_id = $2`,
    [documentId, clientId],
  );
  if (!doc.rowCount) throw new BooksError("document_not_found", "not_found");
  const d = doc.rows[0];
  const lines = await db.query(
    `SELECT l.line_kind, a.sub_type
     FROM books_document_lines l LEFT JOIN books_accounts a ON a.id = l.account_id
     WHERE l.document_id = $1`,
    [documentId],
  );
  const supplyType = documentSupplyType(
    lines.rows.map((l) => lineSupplyType(l.line_kind as string, l.sub_type as string | null)),
  );
  const docType = String(d.doc_type);
  if ((docType === "credit_note" || docType === "debit_note") && d.original_document_id) {
    const orig = await db.query(
      `SELECT place_of_supply FROM books_documents WHERE id = $1 AND client_id = $2`,
      [d.original_document_id, clientId],
    );
    const pos = orig.rows[0]?.place_of_supply as PlaceOfSupply | null | undefined;
    if (pos) return { placeOfSupply: pos, source: "original", supplyType };
  }
  const side = docType === "sales_invoice" || docType === "credit_note" ? "sales" : "purchases";
  return {
    ...decidePlaceOfSupply({
      side,
      supplyType,
      companyEmirate: d.establishment_emirate as string | null,
      party: { country: d.country as string | null, emirate: d.emirate as string | null },
    }),
    supplyType,
  };
}

async function writeResolved(db: PoolClient, clientId: string, documentId: string) {
  const r = await resolveDocumentPlaceOfSupply(db, clientId, documentId);
  await db.query(
    `UPDATE books_documents SET place_of_supply = $3, place_of_supply_source = $4,
       place_of_supply_reason = NULL, supply_type = $5
     WHERE id = $1 AND client_id = $2`,
    [documentId, clientId, r.placeOfSupply, r.source, r.supplyType],
  );
  return r;
}

/** Write the resolved snapshot on a draft unless it carries an override (supply type always kept current). */
export async function refreshDraftPlaceOfSupply(db: PoolClient, clientId: string, documentId: string) {
  const doc = await db.query(
    `SELECT status, place_of_supply_source, party_id FROM books_documents
     WHERE id = $1 AND client_id = $2`,
    [documentId, clientId],
  );
  if (!doc.rowCount) throw new BooksError("document_not_found", "not_found");
  const d = doc.rows[0];
  if (d.status !== "draft" || !d.party_id) return;
  if (d.place_of_supply_source === "override") {
    const r = await resolveDocumentPlaceOfSupply(db, clientId, documentId);
    await db.query(`UPDATE books_documents SET supply_type = $3 WHERE id = $1 AND client_id = $2`, [
      documentId,
      clientId,
      r.supplyType,
    ]);
    return;
  }
  await writeResolved(db, clientId, documentId);
}

/**
 * Admin: re-apply the current rule to every non-override document of the company (drafts and posted),
 * originals before notes. Used when the rule changes (e.g. after tax-adviser review) and before the
 * first VAT return. Each change is audited; overrides are never touched.
 */
export async function reapplyPlaceOfSupplyRule(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const role = await db.query(`SELECT role FROM users WHERE id = $1`, [userId]);
    if (String(role.rows[0]?.role) !== "admin") {
      throw new BooksError("place_of_supply_reapply_requires_admin", "forbidden");
    }
    const docs = await db.query(
      `SELECT id, place_of_supply, place_of_supply_source, supply_type
       FROM books_documents
       WHERE client_id = $1 AND deleted_at IS NULL AND party_id IS NOT NULL
         AND doc_type IN ('sales_invoice', 'purchase_bill', 'credit_note', 'debit_note')
         AND COALESCE(place_of_supply_source, '') <> 'override'
       ORDER BY (doc_type IN ('credit_note', 'debit_note')), created_at`,
      [clientId],
    );
    let changed = 0;
    for (const d of docs.rows) {
      const r = await writeResolved(db, clientId, String(d.id));
      if (
        r.placeOfSupply !== (d.place_of_supply ?? null) ||
        r.source !== d.place_of_supply_source ||
        r.supplyType !== d.supply_type
      ) {
        changed += 1;
        await writeBooksAudit(db, {
          clientId,
          actor: userId,
          action: "reapply_place_of_supply",
          entity: "books_document",
          entityId: String(d.id),
          before: {
            placeOfSupply: d.place_of_supply,
            source: d.place_of_supply_source,
            supplyType: d.supply_type,
          },
          after: r,
        });
      }
    }
    return { checked: docs.rowCount || 0, changed };
  });
}

/**
 * Override the place of supply on a draft (e.g. services performed in another emirate).
 * Reason required; audited with before/after. Pass placeOfSupply = null to clear the override and
 * fall back to the rule (decidePlaceOfSupply).
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
 * Posted sales/purchase documents whose place of supply could not be decided — the VAT 201 readiness
 * gap list. Approve never blocks on this (owner decision 2026-10-06); VAT return generation does.
 * Documents with no VAT-able lines (not_applicable) are not gaps.
 */
export async function listPlaceOfSupplyGaps(
  userId: string,
  clientId: string,
  opts?: { from?: string; to?: string },
) {
  return withUser(userId, async (db) => queryPlaceOfSupplyGaps(db, clientId, opts));
}

export type PlaceOfSupplyGap = {
  id: string;
  docType: string;
  documentNumber: string | null;
  issueDate: string;
  partyId: string;
  partyName: string;
  vatMinor: number;
  supplyType: DocumentSupplyType | null;
  /** company_emirate_missing | party_emirate_missing | mixed_supply */
  why: string;
};

export async function queryPlaceOfSupplyGaps(
  db: PoolClient,
  clientId: string,
  opts?: { from?: string; to?: string },
): Promise<PlaceOfSupplyGap[]> {
  await assertSyntheticTenant(db, clientId);
  const rows = await db.query(
    `SELECT d.id, d.doc_type AS "docType", d.document_number AS "documentNumber",
            d.issue_date AS "issueDate", d.party_id AS "partyId", p.name AS "partyName",
            d.vat_minor AS "vatMinor", d.supply_type AS "supplyType"
     FROM books_documents d
     JOIN books_parties p ON p.id = d.party_id
     WHERE d.client_id = $1 AND d.status = 'posted' AND d.deleted_at IS NULL
       AND d.doc_type IN ('sales_invoice', 'purchase_bill', 'credit_note', 'debit_note')
       AND d.place_of_supply IS NULL
       AND COALESCE(d.place_of_supply_source, 'missing') = 'missing'
       AND ($2::date IS NULL OR d.issue_date >= $2::date)
       AND ($3::date IS NULL OR d.issue_date <= $3::date)
     ORDER BY d.issue_date, d.created_at`,
    [clientId, opts?.from || null, opts?.to || null],
  );
  return rows.rows.map((r) => {
    const sales = r.docType === "sales_invoice" || r.docType === "credit_note";
    const st = (r.supplyType as DocumentSupplyType | null) ?? null;
    const usesCompany = (sales && st === "services") || (!sales && st === "goods");
    return {
      ...r,
      issueDate: String(r.issueDate instanceof Date ? r.issueDate.toISOString() : r.issueDate).slice(0, 10),
      vatMinor: Number(r.vatMinor),
      supplyType: st,
      why: st === "mixed" ? "mixed_supply" : usesCompany ? "company_emirate_missing" : "party_emirate_missing",
    } as PlaceOfSupplyGap;
  });
}
