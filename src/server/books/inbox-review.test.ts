import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import { BooksError } from "@/server/books/errors";
import {
  confirmInboxAsDocument,
  getBooksInboxReview,
  retryBooksInboxExtract,
  uploadBooksInboxFiles,
} from "@/server/books/inbox";
import { createTestCompany } from "@/server/books/test-company";
import { workerInvoiceFieldsJson } from "@/server/books/test-fixtures/worker-extraction";

const OMAR = "55555555-5555-4555-8555-555555555555";

async function withAdmin(t: test.TestContext) {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const adminUrl = process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return null;
  }
  const ready = await admin.query(`SELECT to_regclass('books_extractions') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("phase1 schema not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("upload queues inbox item + extract_document job; writes no fields", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;

  const company = await createTestCompany(admin, "inbox-upload-queue");
  const clientId = company.clientId;

  const pdfPath = path.join(process.cwd(), "fixtures/extraction/pdfs/invoice_02.pdf");
  if (!fs.existsSync(pdfPath)) {
    t.skip("invoice_02.pdf missing");
    await admin.end();
    return;
  }
  const base = fs.readFileSync(pdfPath);
  const bytes = Buffer.concat([base, Buffer.from(`\n%upload-queue-${Date.now()}`)]);

  let uploaded: Awaited<ReturnType<typeof uploadBooksInboxFiles>>;
  try {
    uploaded = await uploadBooksInboxFiles(OMAR, clientId, [
      { filename: "invoice_02.pdf", contentType: "application/pdf", bytes },
    ]);
  } catch (e) {
    t.skip(`upload unavailable (MinIO?): ${e instanceof Error ? e.message : e}`);
    await admin.end();
    return;
  }

  const inboxId = uploaded.results[0]?.inboxItemId;
  assert.ok(inboxId);
  assert.equal(uploaded.results[0].status, "queued");
  assert.equal(uploaded.results[0].duplicate, false);

  const inbox = await admin.query(
    `SELECT status, error FROM books_inbox_items WHERE id = $1`,
    [inboxId],
  );
  assert.equal(inbox.rows[0].status, "queued");
  assert.equal(inbox.rows[0].error, null);

  const jobs = await admin.query(
    `SELECT kind, status, payload
     FROM books_jobs
     WHERE client_id = $1 AND kind = 'extract_document'
       AND payload->>'inboxItemId' = $2`,
    [clientId, inboxId],
  );
  assert.equal(jobs.rowCount, 1, "exactly one extract_document job");
  assert.equal(jobs.rows[0].status, "queued");

  const extractions = await admin.query(
    `SELECT id, fields_json FROM books_extractions WHERE inbox_item_id = $1`,
    [inboxId],
  );
  assert.equal(extractions.rowCount, 0, "web app must not write extraction fields");

  await admin.end();
});

test("review API returns worker-shaped books_extractions for inbox id; 404 for unknown", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;

  const company = await createTestCompany(admin, "inbox-review");
  const clientId = company.clientId;

  const unknown = randomUUID();
  await assert.rejects(
    () => getBooksInboxReview(OMAR, clientId, unknown),
    (err: unknown) => err instanceof BooksError && err.code === "not_found",
  );

  const pdfPath = path.join(process.cwd(), "fixtures/extraction/pdfs/invoice_02.pdf");
  if (!fs.existsSync(pdfPath)) {
    t.skip("invoice_02.pdf missing");
    await admin.end();
    return;
  }
  const base = fs.readFileSync(pdfPath);
  const bytes = Buffer.concat([base, Buffer.from(`\n%slice1-${Date.now()}`)]);

  let uploaded: Awaited<ReturnType<typeof uploadBooksInboxFiles>>;
  try {
    uploaded = await uploadBooksInboxFiles(OMAR, clientId, [
      { filename: "invoice_02.pdf", contentType: "application/pdf", bytes },
    ]);
  } catch (e) {
    t.skip(`upload unavailable (MinIO?): ${e instanceof Error ? e.message : e}`);
    await admin.end();
    return;
  }

  const inboxId = uploaded.results[0]?.inboxItemId;
  assert.ok(inboxId);
  assert.equal(uploaded.results[0].status, "queued");

  // Simulate worker: one books_extractions row with worker fields_json shape.
  const extractionId = randomUUID();
  const fileId = uploaded.results[0].fileId;
  const fields = workerInvoiceFieldsJson({ invoiceNo: "INV-SYN-002" });
  await admin.query(
    `INSERT INTO books_extractions (
       id, client_id, file_id, inbox_item_id, doc_type, status,
       fields_json, raw_text, word_boxes, validation_flags, extractor_version
     ) VALUES ($1,$2,$3,$4,'sales_invoice','needs_review',$5::jsonb,$6,'[]'::jsonb,'[]'::jsonb,'phase1-v1')`,
    [
      extractionId,
      clientId,
      fileId,
      inboxId,
      JSON.stringify(fields),
      "TAX INVOICE\nInvoice No: INV-SYN-002\n",
    ],
  );
  await admin.query(
    `UPDATE books_inbox_items
     SET status = 'needs_review', detected_type = 'sales_invoice',
         classification_confidence = 0.9, updated_at = now()
     WHERE id = $1`,
    [inboxId],
  );

  const review = await getBooksInboxReview(OMAR, clientId, inboxId);
  assert.equal(review.id, inboxId);
  assert.ok(review.extractionId, "extraction row required");
  assert.equal(review.status, "needs_review");
  assert.equal(
    String((review.fieldsJson as { invoice_no?: { value?: string } }).invoice_no?.value),
    "INV-SYN-002",
  );
  assert.equal(
    Number((review.fieldsJson as { net?: { value?: number } }).net?.value),
    10000,
  );
  assert.equal(review.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.match(String(review.fileUrl), /^https?:\/\//);

  const oneRow = await admin.query(
    `SELECT COUNT(*)::int AS n FROM books_extractions WHERE inbox_item_id = $1`,
    [inboxId],
  );
  assert.equal(oneRow.rows[0].n, 1, "exactly one extraction row per inbox item");

  await admin.end();
});

test("retry re-queues extract_document; does not write extraction fields", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;

  const company = await createTestCompany(admin, "inbox-retry");
  const clientId = company.clientId;

  const pdfPath = path.join(process.cwd(), "fixtures/extraction/pdfs/invoice_02.pdf");
  if (!fs.existsSync(pdfPath)) {
    t.skip("invoice_02.pdf missing");
    await admin.end();
    return;
  }
  const base = fs.readFileSync(pdfPath);
  const bytes = Buffer.concat([base, Buffer.from(`\n%retry-${Date.now()}`)]);

  let uploaded: Awaited<ReturnType<typeof uploadBooksInboxFiles>>;
  try {
    uploaded = await uploadBooksInboxFiles(OMAR, clientId, [
      { filename: "invoice_02.pdf", contentType: "application/pdf", bytes },
    ]);
  } catch (e) {
    t.skip(`upload unavailable (MinIO?): ${e instanceof Error ? e.message : e}`);
    await admin.end();
    return;
  }

  const inboxId = uploaded.results[0]?.inboxItemId;
  const fileId = uploaded.results[0]?.fileId;
  assert.ok(inboxId);
  assert.ok(fileId);

  const extractionId = randomUUID();
  const fields = workerInvoiceFieldsJson({ invoiceNo: "INV-RETRY-1" });
  await admin.query(
    `INSERT INTO books_extractions (
       id, client_id, file_id, inbox_item_id, doc_type, status,
       fields_json, raw_text, word_boxes, validation_flags, extractor_version
     ) VALUES ($1,$2,$3,$4,'sales_invoice','needs_review',$5::jsonb,$6,'[]'::jsonb,'[]'::jsonb,'phase1-v1')`,
    [
      extractionId,
      clientId,
      fileId,
      inboxId,
      JSON.stringify(fields),
      "TAX INVOICE\n",
    ],
  );
  await admin.query(
    `UPDATE books_inbox_items
     SET status = 'needs_review', detected_type = 'sales_invoice',
         classification_confidence = 0.9, error = 'stale', updated_at = now()
     WHERE id = $1`,
    [inboxId],
  );

  let retried: Awaited<ReturnType<typeof retryBooksInboxExtract>>;
  try {
    retried = await retryBooksInboxExtract(OMAR, clientId, inboxId);
  } catch (e) {
    t.skip(`retry unavailable (MinIO?): ${e instanceof Error ? e.message : e}`);
    await admin.end();
    return;
  }
  assert.equal(retried.status, "queued");

  const inbox = await admin.query(
    `SELECT status, error FROM books_inbox_items WHERE id = $1`,
    [inboxId],
  );
  assert.equal(inbox.rows[0].status, "queued");
  assert.equal(inbox.rows[0].error, null);

  const jobs = await admin.query(
    `SELECT kind, status
     FROM books_jobs
     WHERE client_id = $1 AND kind = 'extract_document'
       AND payload->>'inboxItemId' = $2`,
    [clientId, inboxId],
  );
  assert.equal(jobs.rowCount, 2, "upload + retry = two extract_document jobs");

  const extractions = await admin.query(
    `SELECT COUNT(*)::int AS n FROM books_extractions WHERE inbox_item_id = $1`,
    [inboxId],
  );
  assert.equal(extractions.rows[0].n, 1, "web app must not add an extraction row on retry");

  await admin.end();
});

test("E1d: confirm rejects null vatCode (never invents SR)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;

  const company = await createTestCompany(admin, "e1d-no-sr");
  const clientId = company.clientId;
  const periodId = company.periods["May 2026"];
  assert.ok(periodId);

  const { createBooksParty } = await import("@/server/books/parties");
  const party = await createBooksParty(OMAR, clientId, {
    partyType: "customer",
    name: `E1d Cust ${Date.now()}`,
    trn: null,
  });
  const partyId = String(party.id);

  const fileId = randomUUID();
  const inboxId = randomUUID();
  const extractionId = randomUUID();
  await admin.query(
    `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
     VALUES ($1,$2,$3,$4,'e1d.pdf','application/pdf',100,$5)`,
    [fileId, clientId, `e1d-${Date.now()}`, `books/${clientId}/${fileId}/e1d.pdf`, OMAR],
  );
  await admin.query(
    `INSERT INTO books_inbox_items (id, client_id, file_id, detected_type, status)
     VALUES ($1,$2,$3,'sales_invoice','needs_review')`,
    [inboxId, clientId, fileId],
  );
  await admin.query(
    `INSERT INTO books_extractions (
       id, client_id, file_id, inbox_item_id, doc_type, status, fields_json, validation_flags
     ) VALUES ($1,$2,$3,$4,'sales_invoice','needs_review',$5::jsonb,'["vat_code_missing"]'::jsonb)`,
    [
      extractionId,
      clientId,
      fileId,
      inboxId,
      JSON.stringify(
        workerInvoiceFieldsJson({
          invoiceNo: "INV-E1D-NULL-VAT",
          netMinor: 10000,
          vatMinor: 0,
          grossMinor: 10000,
          lineVatCode: null,
        }),
      ),
    ],
  );

  await assert.rejects(
    () =>
      confirmInboxAsDocument(OMAR, clientId, inboxId, {
        partyId,
        periodId,
        docType: "sales_invoice",
        issueDate: "2026-05-15",
      }),
    (err: unknown) => {
      assert.ok(err instanceof BooksError);
      assert.match(String(err.message), /vat_code_required/);
      assert.doesNotMatch(String(err.message), /\bSR\b/);
      return true;
    },
  );

  // Explicit SR (evidence / accountant pick) still confirms.
  const ok = await confirmInboxAsDocument(OMAR, clientId, inboxId, {
    partyId,
    periodId,
    docType: "sales_invoice",
    issueDate: "2026-05-15",
    lines: [
      {
        description: "Invoice total",
        vatCode: "SR",
        netMinor: 10000,
        vatMinor: 500,
      },
    ],
  });
  assert.ok(ok.documentId);

  const lines = await admin.query(
    `SELECT vat_code FROM books_document_lines WHERE document_id = $1 ORDER BY line_no`,
    [ok.documentId],
  );
  assert.ok(lines.rowCount && lines.rowCount >= 1);
  assert.equal(lines.rows[0].vat_code, "SR");

  await admin.end();
});
