import { createHash, randomUUID } from "node:crypto";

import { withUser } from "@/lib/db";
import { putObject } from "@/lib/storage";
import { writeBooksAudit } from "@/server/books/audit";
import { BooksError } from "@/server/books/errors";
import { enqueueBooksJob } from "@/server/books/jobs";
import { assertSyntheticTenant } from "@/server/security-gate";

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

export async function uploadBooksInboxFiles(
  userId: string,
  clientId: string | null,
  files: Array<{ filename: string; contentType: string; bytes: Buffer }>,
) {
  return withUser(userId, async (db) => {
    if (clientId) await assertSyntheticTenant(db, clientId);
    const results: Array<{
      inboxItemId: string;
      fileId: string;
      duplicate: boolean;
      sha256: string;
    }> = [];

    for (const file of files) {
      const sha256 = createHash("sha256").update(file.bytes).digest("hex");
      const existing = await db.query(`SELECT id FROM books_files WHERE sha256 = $1`, [sha256]);
      if (existing.rowCount) {
        const inbox = await db.query(
          `INSERT INTO books_inbox_items (client_id, file_id, status, error)
           VALUES ($1,$2,'failed','duplicate_file')
           RETURNING id`,
          [clientId, existing.rows[0].id],
        );
        results.push({
          inboxItemId: String(inbox.rows[0].id),
          fileId: String(existing.rows[0].id),
          duplicate: true,
          sha256,
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
        `INSERT INTO books_inbox_items (id, client_id, file_id, status)
         VALUES ($1,$2,$3,'queued')`,
        [inboxId, clientId, fileId],
      );

      if (clientId) {
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
          after: { filename: file.filename, sha256 },
        });
      }

      results.push({ inboxItemId: inboxId, fileId, duplicate: false, sha256 });
    }
    return { results };
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
