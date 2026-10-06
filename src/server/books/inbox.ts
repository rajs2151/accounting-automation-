import { createHash, randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { displayToMinor } from "@/lib/money";
import { getObjectBytes, putObject, signedGetUrl } from "@/lib/storage";
import { writeBooksAudit } from "@/server/books/audit";
import { createBooksDocument } from "@/server/books/documents";
import { BooksError } from "@/server/books/errors";
import { enqueueBooksJob } from "@/server/books/jobs";
import { parseAmountToFils } from "@/server/books/parsing";
import { assertSyntheticTenant } from "@/server/security-gate";

/** Read a money field from worker fields_json (value may be fils int or display string). */
function fieldMinor(fields: Record<string, unknown>, key: string): number | null {
  const raw = fields[key] as { value?: unknown } | string | number | undefined;
  if (raw == null) return null;
  const value =
    typeof raw === "string" || typeof raw === "number"
      ? raw
      : (raw as { value?: unknown }).value;
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const s = String(value).trim();
  if (!s) return null;
  try {
    return displayToMinor(s) ?? parseAmountToFils(s);
  } catch {
    try {
      return parseAmountToFils(s);
    } catch {
      return null;
    }
  }
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const raw = fields[key] as { value?: unknown } | string | undefined;
  if (typeof raw === "string") return raw;
  if (raw?.value == null || raw.value === "") return "";
  return String(raw.value);
}

/** Prefer primary key, then worker aliases (net/vat/gross, document_number). */
function fieldMinorAlias(
  fields: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const k of keys) {
    const v = fieldMinor(fields, k);
    if (v != null) return v;
  }
  return null;
}

function fieldStrAlias(fields: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = fieldStr(fields, k);
    if (v) return v;
  }
  return "";
}

export async function listBooksInbox(
  userId: string,
  clientId: string | null,
  opts?: { unassignedOnly?: boolean },
) {
  return withUser(userId, async (db) => {
    if (clientId) await assertSyntheticTenant(db, clientId);
    const rows = await db.query(
      `SELECT i.id, i.client_id AS "clientId", i.file_id AS "fileId",
              i.detected_type AS "detectedType",
              i.classification_confidence AS "classificationConfidence",
              i.status, i.error, i.created_at AS "createdAt",
              f.filename, f.sha256, f.content_type AS "contentType"
       FROM books_inbox_items i
       JOIN books_files f ON f.id = i.file_id
       WHERE ($1::boolean AND i.client_id IS NULL)
          OR (NOT $1::boolean AND i.client_id = $2)
       ORDER BY i.created_at DESC
       LIMIT 200`,
      [Boolean(opts?.unassignedOnly), clientId],
    );
    return rows.rows;
  });
}

export async function getBooksInboxReview(
  userId: string,
  clientId: string | null,
  inboxItemId: string,
) {
  return withUser(userId, async (db) => {
    if (clientId) await assertSyntheticTenant(db, clientId);
    const row = await db.query(
      `SELECT i.id, i.client_id AS "clientId", i.file_id AS "fileId",
              i.detected_type AS "detectedType",
              i.classification_confidence AS "classificationConfidence",
              i.status, i.error, i.created_at AS "createdAt",
              f.filename, f.sha256, f.content_type AS "contentType",
              f.storage_key AS "storageKey",
              e.id AS "extractionId", e.fields_json AS "fieldsJson",
              e.raw_text AS "rawText", e.validation_flags AS "validationFlags",
              e.extractor_version AS "extractorVersion", e.doc_type AS "extractionDocType"
       FROM books_inbox_items i
       JOIN books_files f ON f.id = i.file_id
       LEFT JOIN books_extractions e ON e.inbox_item_id = i.id
       WHERE i.id = $1
         AND (
           ($2::uuid IS NULL AND i.client_id IS NULL)
           OR i.client_id = $2
           OR i.client_id IS NULL
         )
       LIMIT 1`,
      [inboxItemId, clientId],
    );
    if (!row.rowCount) throw new BooksError("inbox_not_found", "not_found");
    const r = row.rows[0];
    const fileUrl = await signedGetUrl(String(r.storageKey));
    const fieldsJson = (r.fieldsJson || {}) as Record<string, unknown>;
    const lineItems = Array.isArray(fieldsJson._line_items)
      ? fieldsJson._line_items
      : Array.isArray((fieldsJson.lines as { value?: unknown })?.value)
        ? (fieldsJson.lines as { value: unknown[] }).value
        : [];
    const fields = { ...fieldsJson };
    delete fields._line_items;

    let documentId: string | null = null;
    if (r.extractionId) {
      const linked = await db.query(
        `SELECT id FROM books_documents
         WHERE extraction_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [r.extractionId],
      );
      if (linked.rowCount) documentId = String(linked.rows[0].id);
    }

    return {
      id: r.id,
      clientId: r.clientId,
      fileId: r.fileId,
      filename: r.filename,
      sha256: r.sha256,
      contentType: r.contentType,
      status: r.status,
      error: r.error,
      detectedType: r.detectedType,
      classificationConfidence: r.classificationConfidence,
      fileUrl,
      extractionId: r.extractionId,
      extractorVersion: r.extractorVersion,
      extractionDocType: r.extractionDocType,
      fieldsJson: fields,
      lineItems,
      validationFlags: r.validationFlags || [],
      rawTextPreview: r.rawText ? String(r.rawText).slice(0, 500) : null,
      documentId,
    };
  });
}

function classifyInboxDocType(detected: string): "sales_invoice" | "purchase_bill" {
  const d = detected.toLowerCase();
  if (d.includes("purchase") || d.includes("bill") || d === "debit_note") {
    return "purchase_bill";
  }
  return "sales_invoice";
}

export type InboxIntendedType =
  | "sales_invoice"
  | "purchase_bill"
  | "bank_statement"
  | "card_statement"
  | "gateway_statement";

export async function uploadBooksInboxFiles(
  userId: string,
  clientId: string | null,
  files: Array<{ filename: string; contentType: string; bytes: Buffer }>,
  opts?: { intendedType?: InboxIntendedType | null; userDocType?: string | null },
) {
  return withUser(userId, async (db) => {
    if (clientId) await assertSyntheticTenant(db, clientId);
    const intendedType = opts?.intendedType || null;
    const userDocType = opts?.userDocType || null;
    const results: Array<{
      inboxItemId: string;
      fileId: string;
      duplicate: boolean;
      sha256: string;
      status?: string;
      filename?: string;
      existingDocumentId?: string | null;
    }> = [];

    for (const file of files) {
      const sha256 = createHash("sha256").update(file.bytes).digest("hex");
      // Same bytes already uploaded to this company: point at the existing item, store nothing new
      // (C1 Uploads: "Duplicate: link to the existing document"). Hashes are unique per company (db/32).
      const existing = await db.query(
        `SELECT f.id AS file_id, f.storage_key, i.id AS inbox_id, i.status, d.id AS document_id
         FROM books_files f
         LEFT JOIN LATERAL (
           SELECT id, status FROM books_inbox_items
           WHERE file_id = f.id AND error IS DISTINCT FROM 'duplicate_file'
           ORDER BY created_at LIMIT 1
         ) i ON true
         LEFT JOIN LATERAL (
           SELECT doc.id FROM books_extractions e
           JOIN books_documents doc ON doc.extraction_id = e.id AND doc.deleted_at IS NULL
           WHERE e.inbox_item_id = i.id
           ORDER BY doc.created_at DESC LIMIT 1
         ) d ON true
         WHERE f.sha256 = $1 AND f.client_id IS NOT DISTINCT FROM $2`,
        [sha256, clientId],
      );
      if (existing.rowCount && existing.rows[0].inbox_id) {
        const row = existing.rows[0];
        results.push({
          inboxItemId: String(row.inbox_id),
          fileId: String(row.file_id),
          duplicate: true,
          sha256,
          status: String(row.status),
          filename: file.filename,
          existingDocumentId: row.document_id ? String(row.document_id) : null,
        });
        continue;
      }

      // A stored file whose only inbox rows are legacy duplicate markers: reuse it and queue it again.
      const reuse = existing.rowCount ? existing.rows[0] : null;
      const fileId = reuse ? String(reuse.file_id) : randomUUID();
      const storageKey = reuse
        ? String(reuse.storage_key)
        : `books/${clientId || "unassigned"}/${fileId}/${file.filename}`;
      if (!reuse) {
        await putObject(storageKey, file.bytes, file.contentType || "application/octet-stream");
        await db.query(
          `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            fileId,
            clientId,
            sha256,
            storageKey,
            file.filename,
            file.contentType || "application/octet-stream",
            file.bytes.length,
            userId,
          ],
        );
      }

      const inboxId = randomUUID();
      await db.query(
        `INSERT INTO books_inbox_items (id, client_id, file_id, status, intended_type)
         VALUES ($1,$2,$3,'queued',$4)`,
        [inboxId, clientId, fileId, intendedType],
      );

      // Store + enqueue only — field extraction is the worker's job (no TS sync extract).
      if (clientId) {
        const payload: Record<string, unknown> = {
          inboxItemId: inboxId,
          fileId,
          storageKey,
          filename: file.filename,
        };
        // Statements page (and manual picks) pass userDocType so the worker skips auto-classify.
        if (userDocType) payload.userDocType = userDocType;
        await enqueueBooksJob(db, clientId, "extract_document", payload);
        await writeBooksAudit(db, {
          clientId,
          actor: userId,
          action: "upload",
          entity: "books_inbox_item",
          entityId: inboxId,
          after: {
            filename: file.filename,
            sha256,
            status: "queued",
            intendedType,
            userDocType,
          },
        });
      }

      results.push({
        inboxItemId: inboxId,
        fileId,
        duplicate: false,
        sha256,
        status: "queued",
      });
    }
    return { results };
  });
}

export async function retryBooksInboxExtract(
  userId: string,
  clientId: string,
  inboxItemId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const item = await db.query(
      `SELECT i.id, i.file_id, i.intended_type, f.storage_key, f.filename, f.content_type
       FROM books_inbox_items i
       JOIN books_files f ON f.id = i.file_id
       WHERE i.id = $1 AND (i.client_id = $2 OR i.client_id IS NULL)`,
      [inboxItemId, clientId],
    );
    if (!item.rowCount) throw new BooksError("inbox_not_found", "not_found");
    const row = item.rows[0];
    await db.query(
      `UPDATE books_inbox_items
       SET client_id = $2, status = 'queued', error = NULL, updated_at = now()
       WHERE id = $1`,
      [inboxItemId, clientId],
    );
    // Touch storage so missing objects fail early; extraction itself is worker-only.
    await getObjectBytes(String(row.storage_key));
    const retryPayload: Record<string, unknown> = {
      inboxItemId,
      fileId: String(row.file_id),
      storageKey: String(row.storage_key),
      filename: String(row.filename),
    };
    if (row.intended_type) retryPayload.userDocType = String(row.intended_type);
    await enqueueBooksJob(db, clientId, "extract_document", retryPayload);
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "retry_extract",
      entity: "books_inbox_item",
      entityId: inboxItemId,
      after: { status: "queued" },
    });
    return { id: inboxItemId, status: "queued" };
  });
}

export async function routeInboxItem(
  userId: string,
  inboxItemId: string,
  clientId: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const item = await db.query(`SELECT * FROM books_inbox_items WHERE id = $1`, [inboxItemId]);
    if (!item.rowCount) throw new BooksError("inbox_not_found", "not_found");
    await db.query(
      `UPDATE books_inbox_items SET client_id = $2, status = 'queued', updated_at = now() WHERE id = $1`,
      [inboxItemId, clientId],
    );
    await db.query(`UPDATE books_files SET client_id = $2 WHERE id = $1`, [
      item.rows[0].file_id,
      clientId,
    ]);
    await enqueueBooksJob(db, clientId, "extract_document", {
      inboxItemId,
      fileId: String(item.rows[0].file_id),
    });
    return { id: inboxItemId, clientId };
  });
}

export async function setInboxDocType(
  userId: string,
  clientId: string,
  inboxItemId: string,
  docType: string,
) {
  return withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await db.query(
      `UPDATE books_inbox_items
       SET detected_type = $3, classification_confidence = 1, status = 'needs_review', updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [inboxItemId, clientId, docType],
    );
    return { id: inboxItemId, detectedType: docType };
  });
}

/**
 * Confirm extraction → draft document. Fills printed_* from extracted totals when present.
 * Payments made / balance due are stored as info only (no settlement).
 */
export async function confirmInboxAsDocument(
  userId: string,
  clientId: string,
  inboxItemId: string,
  body: {
    partyId: string;
    periodId: string;
    docType?: "sales_invoice" | "purchase_bill";
    issueDate?: string;
    dueDate?: string | null;
    /** Optional line overrides from review UI (VAT codes the accountant picked). */
    lines?: Array<{
      description?: string;
      vatCode?: string | null;
      vat_code?: string | null;
      netMinor?: number;
      vatMinor?: number;
      lineKind?: string;
    }>;
  },
) {
  const review = await getBooksInboxReview(userId, clientId, inboxItemId);
  if (!review.extractionId) throw new BooksError("extraction_required", "invalid");
  const fields = (review.fieldsJson || {}) as Record<string, unknown>;
  const detected = String(review.detectedType || review.extractionDocType || "");
  const classified = classifyInboxDocType(detected);
  // Positive sales classification only — empty/unknown/receipt must not re-route.
  const isSalesInvoice = detected.toLowerCase() === "sales_invoice";

  // Upload context (Purchases vs Sales) may request a type; classification can re-route.
  let intended: "sales_invoice" | "purchase_bill" | null = body.docType || null;
  await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    const row = await db.query(
      `SELECT intended_type FROM books_inbox_items WHERE id = $1 AND client_id = $2`,
      [inboxItemId, clientId],
    );
    if (row.rowCount && row.rows[0].intended_type) {
      const t = String(row.rows[0].intended_type);
      if (t === "purchase_bill" || t === "sales_invoice") {
        if (!intended) intended = t;
      }
    }
  });

  let docType: "sales_invoice" | "purchase_bill" = intended || classified;
  let reroutedFrom: "purchase_bill" | null = null;
  // Sales invoice uploaded under Purchases → move to Sales (never a purchase_bill).
  if (
    (intended === "purchase_bill" || body.docType === "purchase_bill") &&
    isSalesInvoice
  ) {
    docType = "sales_invoice";
    reroutedFrom = "purchase_bill";
  }

  type ConfirmLine = {
    description?: string;
    vatCode?: string | null;
    vat_code?: string | null;
    netMinor?: number;
    vatMinor?: number;
    lineKind?: string;
  };

  // Optional UI override (accountant picked VAT codes). Never invent SR here.
  const overrideLines = Array.isArray(body.lines) ? (body.lines as ConfirmLine[]) : null;
  const sourceLines = (overrideLines && overrideLines.length > 0
    ? overrideLines
    : (review.lineItems || [])) as ConfirmLine[];

  function normalizeVatCode(raw: unknown): string | null {
    if (raw == null) return null;
    const s = String(raw).trim();
    return s ? s : null;
  }

  const lines =
    sourceLines.length > 0
      ? sourceLines.map((l) => ({
          description: l.description || "Line",
          lineKind: (l.lineKind as "revenue" | "expense" | "disbursement") ||
            (docType === "purchase_bill" ? "expense" : "revenue"),
          vatCode: normalizeVatCode(l.vatCode ?? l.vat_code),
          netMinor: Number(l.netMinor || 0),
          vatMinor: Number(l.vatMinor || 0),
        }))
      : [
          {
            description: "Extracted line",
            lineKind: (docType === "purchase_bill" ? "expense" : "revenue") as "expense" | "revenue",
            // No evidence → null (never invent SR). Confirm is blocked below.
            vatCode: null as string | null,
            netMinor: fieldMinorAlias(fields, ["subtotal", "net"]) ?? 0,
            vatMinor: fieldMinorAlias(fields, ["vat_total", "vat"]) ?? 0,
          },
        ];

  const missingVat = lines
    .map((l, i) => ({ i, ...l }))
    .filter((l) => l.lineKind !== "disbursement" && !l.vatCode);
  if (missingVat.length) {
    const labels = missingVat
      .map((l) => l.description || `line ${l.i + 1}`)
      .slice(0, 5)
      .join(", ");
    throw new BooksError(
      `vat_code_required: pick a VAT code before confirm (${labels})`,
      "invalid",
    );
  }

  const invoiceDateRaw =
    fieldStrAlias(fields, ["invoice_date", "document_date"]);
  let issueDate = body.issueDate;
  if (!issueDate && invoiceDateRaw) {
    if (/^\d{4}-\d{2}-\d{2}/.test(invoiceDateRaw)) {
      issueDate = invoiceDateRaw.slice(0, 10);
    } else {
      const m = invoiceDateRaw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) issueDate = `${m[3]}-${m[2]}-${m[1]}`;
    }
  }
  if (!issueDate) issueDate = new Date().toISOString().slice(0, 10);

  // Worker fields_json uses net/vat/gross (fils int); legacy aliases kept for fixtures.
  const printedNet = fieldMinorAlias(fields, ["subtotal", "net"]);
  const printedVat = fieldMinorAlias(fields, ["vat_total", "vat"]);
  const printedGross = fieldMinorAlias(fields, ["grand_total", "gross"]);
  const printedPaid =
    fieldMinor(fields, "amount_paid") ?? fieldMinor(fields, "payments_made");
  const printedBalanceDue =
    fieldMinor(fields, "balance_due") ?? fieldMinor(fields, "amount_due");

  const created = await createBooksDocument(userId, clientId, {
    docType,
    partyId: body.partyId,
    periodId: body.periodId,
    issueDate,
    dueDate: body.dueDate ?? null,
    documentNumber:
      fieldStrAlias(fields, ["invoice_no", "document_number"]) || null,
    currency: fieldStr(fields, "currency") || "AED",
    lines,
    printedNetMinor: printedNet,
    printedVatMinor: printedVat,
    printedGrossMinor: printedGross,
    printedPaidMinor: printedPaid,
    printedBalanceDueMinor: printedBalanceDue,
    extractionId: String(review.extractionId),
    fileId: String(review.fileId),
  });

  const notice = reroutedFrom
    ? "Classified as sales invoice — moved to Sales (not posted as a purchase)."
    : null;

  await withUser(userId, async (db) => {
    await assertSyntheticTenant(db, clientId);
    await db.query(
      `UPDATE books_inbox_items SET status = 'confirmed', updated_at = now()
       WHERE id = $1 AND client_id = $2`,
      [inboxItemId, clientId],
    );
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "confirm_inbox_document",
      entity: "books_inbox_item",
      entityId: inboxItemId,
      after: {
        documentId: created.id,
        printedGrossMinor: printedGross,
        docType,
        reroutedFrom,
        notice,
      },
    });
    if (reroutedFrom) {
      await writeBooksAudit(db, {
        clientId,
        actor: userId,
        action: "reroute_doc_type",
        entity: "books_document",
        entityId: String(created.id),
        before: { docType: reroutedFrom },
        after: { docType, notice, inboxItemId },
      });
    }
  });

  return {
    inboxItemId,
    documentId: String(created.id),
    document: created,
    docType,
    reroutedFrom,
    notice,
  };
}
