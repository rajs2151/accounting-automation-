import type { PoolClient } from "pg";

import { withUser } from "@/lib/db";
import { BooksError } from "@/server/books/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export type OpenItemRow = {
  id: string;
  partyId: string;
  documentId: string | null;
  journalEntryId: string;
  side: "AR" | "AP";
  currency: string;
  originalMinor: number;
  aedOriginalMinor: number;
  openOriginalMinor: number;
  openAedMinor: number;
  fxRateScaled: number;
  status: string;
};

/** Create or refresh open item when SV/PV/CN/DN journal is posted. */
export async function upsertOpenItemFromDocument(
  db: PoolClient,
  args: {
    clientId: string;
    partyId: string;
    documentId: string;
    journalEntryId: string;
    side: "AR" | "AP";
    currency: string;
    originalMinor: number;
    aedMinor: number;
    fxRateScaled: number;
    /** Negative for CN/DN reducing balance */
    signed?: boolean;
  },
) {
  const original = args.originalMinor;
  const aed = args.aedMinor;
  if (original === 0 && aed === 0) return null;

  const existing = await db.query(
    `SELECT id FROM books_open_items WHERE document_id = $1 AND client_id = $2`,
    [args.documentId, args.clientId],
  );
  if (existing.rowCount) {
    await db.query(
      `UPDATE books_open_items SET
         original_minor = $3, aed_original_minor = $4,
         open_original_minor = $3, open_aed_minor = $4,
         status = CASE WHEN $3 = 0 THEN 'closed' ELSE 'open' END,
         updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [existing.rows[0].id, args.clientId, original, aed],
    );
    return String(existing.rows[0].id);
  }
  const inserted = await db.query(
    `INSERT INTO books_open_items (
       client_id, party_id, document_id, journal_entry_id, side, currency,
       original_minor, aed_original_minor, open_original_minor, open_aed_minor, fx_rate_scaled, status
     ) VALUES (
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::char(3),
       $7::bigint,$8::bigint,$7::bigint,$8::bigint,$9::bigint,
       CASE WHEN $7::bigint = 0 THEN 'closed' ELSE 'open' END
     )
     RETURNING id`,
    [
      args.clientId,
      args.partyId,
      args.documentId,
      args.journalEntryId,
      args.side,
      args.currency,
      original,
      aed,
      args.fxRateScaled,
    ],
  );
  return String(inserted.rows[0].id);
}

export async function applyAllocationToOpenItem(
  db: PoolClient,
  openItemId: string,
  clientId: string,
  allocOriginal: number,
  allocAed: number,
) {
  const row = await db.query(
    `SELECT open_original_minor, open_aed_minor FROM books_open_items
     WHERE id = $1 AND client_id = $2 FOR UPDATE`,
    [openItemId, clientId],
  );
  if (!row.rowCount) throw new BooksError("open_item_not_found", "not_found");
  const openOrig = Number(row.rows[0].open_original_minor);
  const openAed = Number(row.rows[0].open_aed_minor);
  if (allocOriginal > openOrig) throw new BooksError("allocation_exceeds_open", "invalid");
  const nextOrig = openOrig - allocOriginal;
  const nextAed = openAed - allocAed;
  await db.query(
    `UPDATE books_open_items SET
       open_original_minor = $3::bigint,
       open_aed_minor = $4::bigint,
       status = CASE
         WHEN $3::bigint = 0 THEN 'closed'
         WHEN $3::bigint < original_minor THEN 'partial'
         ELSE 'open'
       END,
       updated_at = now()
     WHERE id = $1::uuid AND client_id = $2::uuid`,
    [openItemId, clientId, nextOrig, Math.max(0, nextAed)],
  );
}

export async function listBooksOpenItems(
  userId: string,
  clientId: string,
  opts?: { partyId?: string; side?: string; status?: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT oi.id, oi.party_id AS "partyId", oi.document_id AS "documentId",
              oi.journal_entry_id AS "journalEntryId", oi.side, oi.currency,
              oi.original_minor AS "originalMinor", oi.aed_original_minor AS "aedOriginalMinor",
              oi.open_original_minor AS "openOriginalMinor", oi.open_aed_minor AS "openAedMinor",
              oi.fx_rate_scaled AS "fxRateScaled", oi.status,
              p.name AS "partyName", d.document_number AS "documentNumber", d.doc_type AS "docType"
       FROM books_open_items oi
       JOIN books_parties p ON p.id = oi.party_id
       LEFT JOIN books_documents d ON d.id = oi.document_id
       WHERE oi.client_id = $1
         AND ($2::uuid IS NULL OR oi.party_id = $2)
         AND ($3::text IS NULL OR oi.side = $3)
         AND ($4::text IS NULL OR oi.status = $4)
       ORDER BY oi.created_at DESC`,
      [clientId, opts?.partyId || null, opts?.side || null, opts?.status || null],
    );
    return rows.rows;
  });
}

/**
 * Rebuild open items from posted SV/PV/CN/DN journals + allocations.
 * Used for integrity test: rebuild == table.
 */
export async function rebuildOpenItemsFromJournals(db: PoolClient, clientId: string) {
  type Key = string;
  const map = new Map<
    Key,
    {
      partyId: string;
      documentId: string;
      journalEntryId: string;
      side: "AR" | "AP";
      currency: string;
      originalMinor: number;
      aedOriginalMinor: number;
      fxRateScaled: number;
    }
  >();

  const docs = await db.query(
    `SELECT d.id, d.party_id, d.journal_entry_id, d.doc_type, d.doc_kind,
            d.currency, d.original_total_minor, d.aed_total_minor, d.fx_rate_scaled, d.gross_minor
     FROM books_documents d
     JOIN books_journal_entries e ON e.id = d.journal_entry_id
     WHERE d.client_id = $1 AND d.deleted_at IS NULL
       AND d.doc_type IN ('sales_invoice','purchase_bill','credit_note','debit_note')
       AND e.status IN ('posted','reversed')
       AND d.party_id IS NOT NULL AND d.journal_entry_id IS NOT NULL`,
    [clientId],
  );

  for (const d of docs.rows) {
    if (String(d.status) === "reversed") continue;
    const entry = await db.query(
      `SELECT status FROM books_journal_entries WHERE id = $1`,
      [d.journal_entry_id],
    );
    if (!entry.rowCount || entry.rows[0].status !== "posted") continue;

    const docType = String(d.doc_type);
    let side: "AR" | "AP" =
      docType === "sales_invoice" || docType === "credit_note" ? "AR" : "AP";
    if (docType === "credit_note") side = "AR";
    if (docType === "debit_note") side = "AP";

    let orig = Number(d.original_total_minor || d.gross_minor);
    let aed = Number(d.aed_total_minor || d.gross_minor);
    if (docType === "credit_note" || docType === "debit_note") {
      // CN/DN reduce the original's open balance — represented as negative contribution
      // against original document via allocations path; standalone OI for CN/DN uses negative open.
      orig = -Math.abs(orig);
      aed = -Math.abs(aed);
    }

    map.set(String(d.id), {
      partyId: String(d.party_id),
      documentId: String(d.id),
      journalEntryId: String(d.journal_entry_id),
      side,
      currency: String(d.currency || "AED"),
      originalMinor: Math.abs(Number(d.original_total_minor || d.gross_minor)),
      aedOriginalMinor: Math.abs(Number(d.aed_total_minor || d.gross_minor)),
      fxRateScaled: Number(d.fx_rate_scaled || 100000000),
    });

    // Store signed opens separately after allocations
    void orig;
    void aed;
  }

  // Start with full opens for invoices/bills; apply CN/DN linked reductions + RV/PY allocations
  const rebuilt: Array<{
    documentId: string;
    openOriginalMinor: number;
    openAedMinor: number;
    status: string;
  }> = [];

  for (const [docId, base] of map) {
    const docMeta = docs.rows.find((r) => String(r.id) === docId);
    const docType = String(docMeta?.doc_type);
    if (docType === "credit_note" || docType === "debit_note") continue;

    let openOrig = base.originalMinor;
    let openAed = base.aedOriginalMinor;

    const notes = await db.query(
      `SELECT COALESCE(SUM(gross_minor),0)::bigint AS g,
              COALESCE(SUM(original_total_minor),0)::bigint AS o,
              COALESCE(SUM(aed_total_minor),0)::bigint AS a
       FROM books_documents
       WHERE original_document_id = $1 AND client_id = $2
         AND deleted_at IS NULL AND status IN ('posted','approved','partially_paid','paid')
         AND doc_type IN ('credit_note','debit_note')`,
      [docId, clientId],
    );
    openOrig -= Math.abs(Number(notes.rows[0].o || notes.rows[0].g));
    openAed -= Math.abs(Number(notes.rows[0].a || notes.rows[0].g));

    const allocs = await db.query(
      `SELECT COALESCE(SUM(a.allocated_original_minor),0)::bigint AS o,
              COALESCE(SUM(a.allocated_aed_minor),0)::bigint AS a
       FROM books_allocations a
       JOIN books_open_items oi ON oi.id = a.open_item_id
       WHERE oi.document_id = $1 AND a.client_id = $2`,
      [docId, clientId],
    );
    openOrig -= Number(allocs.rows[0].o);
    openAed -= Number(allocs.rows[0].a);

    openOrig = Math.max(0, openOrig);
    openAed = Math.max(0, openAed);
    rebuilt.push({
      documentId: docId,
      openOriginalMinor: openOrig,
      openAedMinor: openAed,
      status: openOrig === 0 ? "closed" : openOrig < base.originalMinor ? "partial" : "open",
    });
  }

  return rebuilt;
}

export async function assertOpenItemsMatchRebuild(userId: string, clientId: string) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const rebuilt = await rebuildOpenItemsFromJournals(db, clientId);
    const table = await db.query(
      `SELECT document_id AS "documentId", open_original_minor AS "openOriginalMinor",
              open_aed_minor AS "openAedMinor", status
       FROM books_open_items
       WHERE client_id = $1 AND document_id IS NOT NULL`,
      [clientId],
    );
    const byDoc = new Map(table.rows.map((r) => [String(r.documentId), r]));
    const mismatches: string[] = [];
    for (const r of rebuilt) {
      const t = byDoc.get(r.documentId);
      if (!t) {
        mismatches.push(`missing_table:${r.documentId}`);
        continue;
      }
      if (Number(t.openOriginalMinor) !== r.openOriginalMinor) {
        mismatches.push(`orig:${r.documentId}`);
      }
      if (Number(t.openAedMinor) !== r.openAedMinor) {
        mismatches.push(`aed:${r.documentId}`);
      }
    }
    return { ok: mismatches.length === 0, mismatches, rebuiltCount: rebuilt.length };
  });
}
