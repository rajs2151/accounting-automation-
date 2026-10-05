import { createHash, randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { displayToMinor } from "@/lib/money";
import { getObjectBytes, putObject, signedGetUrl } from "@/lib/storage";
import { writeBooksAudit } from "@/server/books/audit";
import { createBooksDocument } from "@/server/books/documents";
import { BooksError } from "@/server/books/errors";
import { syncExtractInboxItem } from "@/server/books/extract-sync";
import { enqueueBooksJob } from "@/server/books/jobs";
import { parseAmountToFils } from "@/server/books/parsing";
import { assertSyntheticTenant } from "@/server/security-gate";

function fieldMinor(fields: Record<string, unknown>, key: string): number | null {
  const raw = fields[key] as { value?: string } | string | undefined;
  const value = typeof raw === "string" ? raw : raw?.value;
  if (!value || !String(value).trim()) return null;
  try {
    return displayToMinor(String(value).trim()) ?? parseAmountToFils(String(value));
  } catch {
    try {
      return parseAmountToFils(String(value));
    } catch {
      return null;
    }
  }
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const raw = fields[key] as { value?: string } | string | undefined;
  if (typeof raw === "string") return raw;
  return raw?.value ? String(raw.value) : "";
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

export async function uploadBooksInboxFiles(
  userId: string,
  clientId: string | null,
  files: Array<{ filename: string; contentType: string; bytes: Buffer }>,
  opts?: { intendedType?: "sales_invoice" | "purchase_bill" | null },
) {
  return withUser(userId, async (db) => {
    if (clientId) await assertSyntheticTenant(db, clientId);
    const intendedType = opts?.intendedType || null;
    const results: Array<{
      inboxItemId: string;
      fileId: string;
      duplicate: boolean;
      sha256: string;
      status?: string;
    }> = [];

    for (const file of files) {
      const sha256 = createHash("sha256").update(file.bytes).digest("hex");
      const existing = await db.query(`SELECT id FROM books_files WHERE sha256 = $1`, [sha256]);
      if (existing.rowCount) {
        const inbox = await db.query(
          `INSERT INTO books_inbox_items (client_id, file_id, status, error, intended_type)
           VALUES ($1,$2,'failed','duplicate_file',$3)
           RETURNING id`,
          [clientId, existing.rows[0].id, intendedType],
        );
        results.push({
          inboxItemId: String(inbox.rows[0].id),
          fileId: String(existing.rows[0].id),
          duplicate: true,
          sha256,
          status: "failed",
        });
        continue;
      }

      const fileId = randomUUID();
      const storageKey = `books/${clientId || "unassigned"}/${fileId}/${file.filename}`;
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

      const inboxId = randomUUID();
      await db.query(
        `INSERT INTO books_inbox_items (id, client_id, file_id, status, intended_type)
         VALUES ($1,$2,$3,'extracting',$4)`,
        [inboxId, clientId, fileId, intendedType],
      );

      // Sync text extract so review works without waiting on the worker (e2e).
      const sync = await syncExtractInboxItem(db, {
        inboxItemId: inboxId,
        fileId,
        clientId,
        filename: file.filename,
        bytes: file.bytes,
        contentType: file.contentType,
      });

      if (clientId && sync.status === "queued") {
        await enqueueBooksJob(db, clientId, "extract_document", {
          inboxItemId: inboxId,
          fileId,
          storageKey,
          filename: file.filename,
        });
      } else if (clientId) {
        // Still enqueue worker for OCR enrichment; unique index replaces sync row.
        await enqueueBooksJob(db, clientId, "extract_document", {
          inboxItemId: inboxId,
          fileId,
          storageKey,
          filename: file.filename,
        });
      }

      if (clientId) {
        await writeBooksAudit(db, {
          clientId,
          actor: userId,
          action: "upload",
          entity: "books_inbox_item",
          entityId: inboxId,
          after: { filename: file.filename, sha256, syncStatus: sync.status },
        });
      }

      results.push({
        inboxItemId: inboxId,
        fileId,
        duplicate: false,
        sha256,
        status: sync.status,
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
      `SELECT i.id, i.file_id, f.storage_key, f.filename, f.content_type
       FROM books_inbox_items i
       JOIN books_files f ON f.id = i.file_id
       WHERE i.id = $1 AND (i.client_id = $2 OR i.client_id IS NULL)`,
      [inboxItemId, clientId],
    );
    if (!item.rowCount) throw new BooksError("inbox_not_found", "not_found");
    const row = item.rows[0];
    await db.query(
      `UPDATE books_inbox_items
       SET client_id = $2, status = 'extracting', error = NULL, updated_at = now()
       WHERE id = $1`,
      [inboxItemId, clientId],
    );
    const bytes = await getObjectBytes(String(row.storage_key));
    const sync = await syncExtractInboxItem(db, {
      inboxItemId,
      fileId: String(row.file_id),
      clientId,
      filename: String(row.filename),
      bytes,
      contentType: String(row.content_type || ""),
    });
    await enqueueBooksJob(db, clientId, "extract_document", {
      inboxItemId,
      fileId: String(row.file_id),
      storageKey: String(row.storage_key),
      filename: String(row.filename),
    });
    await writeBooksAudit(db, {
      clientId,
      actor: userId,
      action: "retry_extract",
      entity: "books_inbox_item",
      entityId: inboxItemId,
      after: { status: sync.status },
    });
    return { id: inboxItemId, status: sync.status };
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

  const lineItems = (review.lineItems || []) as Array<{
    description?: string;
    vatCode?: string;
    netMinor?: number;
    vatMinor?: number;
    lineKind?: string;
  }>;
  const lines =
    lineItems.length > 0
      ? lineItems.map((l) => ({
          description: l.description || "Line",
          lineKind: (l.lineKind as "revenue" | "expense" | "disbursement") ||
            (docType === "purchase_bill" ? "expense" : "revenue"),
          vatCode: l.vatCode || "SR",
          netMinor: Number(l.netMinor || 0),
          vatMinor: Number(l.vatMinor || 0),
        }))
      : [
          {
            description: "Extracted line",
            lineKind: (docType === "purchase_bill" ? "expense" : "revenue") as "expense" | "revenue",
            vatCode: "SR",
            netMinor: fieldMinor(fields, "subtotal") ?? 0,
            vatMinor: fieldMinor(fields, "vat_total") ?? 0,
          },
        ];

  const invoiceDateRaw = fieldStr(fields, "invoice_date");
  let issueDate = body.issueDate;
  if (!issueDate && invoiceDateRaw) {
    const m = invoiceDateRaw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) issueDate = `${m[3]}-${m[2]}-${m[1]}`;
  }
  if (!issueDate) issueDate = new Date().toISOString().slice(0, 10);

  const printedNet = fieldMinor(fields, "subtotal");
  const printedVat = fieldMinor(fields, "vat_total");
  const printedGross = fieldMinor(fields, "grand_total");
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
    documentNumber: fieldStr(fields, "invoice_no") || null,
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
