import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { allowRealClientData } from "@/config/security";
import { withUser } from "@/lib/db";
import { LedgerError } from "@/server/errors";
import { assertSyntheticTenant } from "@/server/security-gate";

export type InboxRow = {
  id: string;
  firmId: string;
  fileId: string;
  originalName: string;
  routingStatus: string;
  detectedClientId: string | null;
  detectedPeriodId: string | null;
  routedDocumentId: string | null;
  routingConfidence: number;
  detectedDocType: string | null;
  duplicateOf: string | null;
  ocrUsed: boolean;
  extractionConfidence: number;
  createdAt: string;
};

const DOC_TYPE_HINTS: { re: RegExp; docType: string; confidence: number }[] = [
  { re: /stripe|balance[_-]?history/i, docType: "GATEWAY_CSV", confidence: 85 },
  { re: /nomod|network.?international|checkout/i, docType: "GATEWAY_PDF", confidence: 70 },
  { re: /card.?statement|credit.?card|visa|mastercard/i, docType: "CARD_STATEMENT", confidence: 75 },
  { re: /bank.?statement|statement.?of.?account|iban/i, docType: "BANK_STATEMENT", confidence: 70 },
  { re: /trial.?balance|opening.?tb/i, docType: "OPENING_TB", confidence: 80 },
  { re: /tax.?invoice|sales.?invoice|tax invoice/i, docType: "SALES_INVOICE", confidence: 65 },
  { re: /purchase|supplier.?bill|vendor.?bill/i, docType: "PURCHASE_INVOICE", confidence: 65 },
];

export function detectDocTypeFromName(name: string): { docType: string; confidence: number } {
  for (const hint of DOC_TYPE_HINTS) {
    if (hint.re.test(name)) return { docType: hint.docType, confidence: hint.confidence };
  }
  return { docType: "OTHER", confidence: 20 };
}

function mapInbox(row: Record<string, unknown>): InboxRow {
  return {
    id: String(row.id),
    firmId: String(row.firmId ?? row.firm_id),
    fileId: String(row.fileId ?? row.file_id),
    originalName: String(row.originalName ?? row.original_name ?? ""),
    routingStatus: String(row.routingStatus ?? row.routing_status),
    detectedClientId: (row.detectedClientId ?? row.detected_client_id ?? null) as string | null,
    detectedPeriodId: (row.detectedPeriodId ?? row.detected_period_id ?? null) as string | null,
    routedDocumentId: (row.routedDocumentId ?? row.routed_document_id ?? null) as string | null,
    routingConfidence: Number(row.routingConfidence ?? row.routing_confidence ?? 0),
    detectedDocType: (row.detectedDocType ?? row.detected_doc_type ?? null) as string | null,
    duplicateOf: (row.duplicateOf ?? row.duplicate_of ?? null) as string | null,
    ocrUsed: Boolean(row.ocrUsed ?? row.ocr_used),
    extractionConfidence: Number(row.extractionConfidence ?? row.extraction_confidence ?? 0),
    createdAt: String(row.createdAt ?? row.created_at),
  };
}

async function firmIdForUser(db: PoolClient, userId: string) {
  const row = await db.query(`SELECT firm_id AS "firmId" FROM users WHERE id = $1`, [userId]);
  if (!row.rowCount) throw new LedgerError("user_not_found", "not_found");
  return String(row.rows[0].firmId);
}

export async function listUnassignedInbox(userId: string) {
  return withUser(userId, async (db) => {
    const firmId = await firmIdForUser(db, userId);
    const rows = await db.query(
      `SELECT i.id, i.firm_id AS "firmId", i.file_id AS "fileId", f.original_name AS "originalName",
              i.routing_status AS "routingStatus", i.detected_client_id AS "detectedClientId",
              i.detected_period_id AS "detectedPeriodId", i.routed_document_id AS "routedDocumentId",
              i.routing_confidence AS "routingConfidence", i.detected_doc_type AS "detectedDocType",
              i.duplicate_of AS "duplicateOf", i.ocr_used AS "ocrUsed",
              i.extraction_confidence AS "extractionConfidence", i.created_at AS "createdAt"
       FROM document_inbox i
       JOIN files f ON f.id = i.file_id
       WHERE i.firm_id = $1 AND i.routing_status = 'pending'
       ORDER BY i.created_at DESC
       LIMIT 200`,
      [firmId],
    );
    return rows.rows.map(mapInbox);
  });
}

/** Register a firm-level upload into the unassigned inbox (no auto-post). */
export async function registerFirmInboxUpload(
  userId: string,
  body: {
    originalName: string;
    detectedMime: string;
    size: number;
    storageKey: string;
    contentSha256: string;
    ocrUsed?: boolean;
  },
) {
  return withUser(userId, async (db) => {
    const firmId = await firmIdForUser(db, userId);
    const detected = detectDocTypeFromName(body.originalName);

    const dup = await db.query(
      `SELECT id FROM files WHERE firm_id = $1 AND sha256 = $2 LIMIT 1`,
      [firmId, body.contentSha256],
    );

    const fileId = randomUUID();
    if (!dup.rowCount) {
      await db.query(
        `INSERT INTO files (id, firm_id, client_id, sha256, original_name, detected_mime, size, storage_key, uploaded_by)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8)`,
        [
          fileId,
          firmId,
          body.contentSha256,
          body.originalName,
          body.detectedMime,
          body.size,
          body.storageKey,
          userId,
        ],
      );
    }
    const useFileId = dup.rowCount ? String(dup.rows[0].id) : fileId;

    // Soft client detect via TRN / legal name / IBAN mask fragments in filename.
    const clients = await db.query(
      `SELECT c.id, p.legal_name, p.trn, p.ibans_json
       FROM clients c
       LEFT JOIN client_profile p ON p.client_id = c.id
       WHERE c.firm_id = $1 AND (${allowRealClientData() ? "true" : "c.is_synthetic = true"})`,
      [firmId],
    );
    let detectedClientId: string | null = null;
    let routingConfidence = detected.confidence;
    const lower = body.originalName.toLowerCase();
    for (const client of clients.rows) {
      const legal = String(client.legal_name || "").toLowerCase();
      const trn = String(client.trn || "");
      if (legal && lower.includes(legal.slice(0, Math.min(12, legal.length)))) {
        detectedClientId = String(client.id);
        routingConfidence = Math.max(routingConfidence, 60);
        break;
      }
      if (trn && lower.includes(trn)) {
        detectedClientId = String(client.id);
        routingConfidence = Math.max(routingConfidence, 90);
        break;
      }
    }

    // Require high confidence to auto-suggest; never auto-route below 80.
    if (routingConfidence < 80) detectedClientId = detectedClientId && routingConfidence >= 60 ? detectedClientId : null;

    const inboxId = randomUUID();
    const duplicateOf = dup.rowCount
      ? (
          await db.query(
            `SELECT id FROM document_inbox WHERE file_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [useFileId],
          )
        ).rows[0]?.id
      : null;

    await db.query(
      `INSERT INTO document_inbox (
         id, firm_id, file_id, routing_status, detected_client_id, routing_confidence,
         detected_doc_type, duplicate_of, ocr_used, extraction_confidence, uploaded_by
       ) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10)`,
      [
        inboxId,
        firmId,
        useFileId,
        detectedClientId,
        routingConfidence,
        detected.docType,
        duplicateOf || null,
        body.ocrUsed ?? false,
        body.ocrUsed ? 35 : routingConfidence,
        userId,
      ],
    );

    return mapInbox({
      id: inboxId,
      firmId,
      fileId: useFileId,
      originalName: body.originalName,
      routingStatus: "pending",
      detectedClientId,
      detectedPeriodId: null,
      routedDocumentId: null,
      routingConfidence,
      detectedDocType: detected.docType,
      duplicateOf: duplicateOf || null,
      ocrUsed: body.ocrUsed ?? false,
      extractionConfidence: body.ocrUsed ? 35 : routingConfidence,
      createdAt: new Date().toISOString(),
    });
  });
}

export async function routeInboxItem(
  userId: string,
  inboxId: string,
  body: { clientId: string; periodId: string; docType?: string },
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, body.clientId);
    const firmId = await firmIdForUser(db, userId);
    const inbox = await db.query(
      `SELECT i.*, f.original_name
       FROM document_inbox i
       JOIN files f ON f.id = i.file_id
       WHERE i.id = $1 AND i.firm_id = $2`,
      [inboxId, firmId],
    );
    if (!inbox.rowCount) throw new LedgerError("inbox_not_found", "not_found");
    const row = inbox.rows[0];
    if (row.routing_status === "routed") throw new LedgerError("already_routed", "conflict");

    const period = await db.query(
      `SELECT id FROM accounting_periods WHERE id = $1 AND client_id = $2`,
      [body.periodId, body.clientId],
    );
    if (!period.rowCount) throw new LedgerError("period_not_found", "not_found");

    await db.query(`UPDATE files SET client_id = $1 WHERE id = $2`, [body.clientId, row.file_id]);

    const documentId = randomUUID();
    const docType = body.docType || row.detected_doc_type || "OTHER";
    await db.query(
      `INSERT INTO documents (
         id, client_id, period_id, file_id, doc_type, original_name, status, created_by,
         detected_client_id, routing_confidence, ocr_used, extraction_confidence
       ) VALUES ($1,$2,$3,$4,$5,$6,'uploaded',$7,$2,$8,$9,$10)`,
      [
        documentId,
        body.clientId,
        body.periodId,
        row.file_id,
        docType,
        row.original_name,
        userId,
        row.routing_confidence,
        row.ocr_used,
        row.extraction_confidence,
      ],
    );

    await db.query(
      `UPDATE document_inbox
       SET routing_status = 'routed',
           detected_client_id = $2,
           detected_period_id = $3,
           routed_document_id = $4,
           updated_at = now()
       WHERE id = $1`,
      [inboxId, body.clientId, body.periodId, documentId],
    );

    await db.query(
      `INSERT INTO period_pipeline_status (client_id, period_id, stage, last_run_at)
       VALUES ($1,$2,'DOCS_COLLECTING', now())
       ON CONFLICT (client_id, period_id) DO UPDATE SET last_run_at = now(), updated_at = now()`,
      [body.clientId, body.periodId],
    );

    return { inboxId, documentId, clientId: body.clientId, periodId: body.periodId, docType };
  });
}

export function sha256Hex(buf: Buffer | string) {
  return createHash("sha256").update(buf).digest("hex");
}
