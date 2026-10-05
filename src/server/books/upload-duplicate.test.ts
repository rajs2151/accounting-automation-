import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import { uploadBooksInboxFiles } from "@/server/books/inbox";
import { createTestCompany } from "@/server/books/test-company";

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
  return admin;
}

function uniquePdf(tag: string): Buffer | null {
  const pdfPath = path.join(process.cwd(), "fixtures/extraction/pdfs/invoice_02.pdf");
  if (!fs.existsSync(pdfPath)) return null;
  return Buffer.concat([fs.readFileSync(pdfPath), Buffer.from(`\n%${tag}-${Date.now()}-${Math.random()}`)]);
}

test("re-uploading identical bytes returns the existing item and stores nothing new", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  const company = await createTestCompany(admin, "upload-duplicate");
  const bytes = uniquePdf("dup");
  if (!bytes) {
    t.skip("invoice_02.pdf missing");
    await admin.end();
    return;
  }
  const file = { filename: "invoice_02.pdf", contentType: "application/pdf", bytes };

  let first: Awaited<ReturnType<typeof uploadBooksInboxFiles>>;
  try {
    first = await uploadBooksInboxFiles(OMAR, company.clientId, [file]);
  } catch (e) {
    t.skip(`upload unavailable (MinIO?): ${e instanceof Error ? e.message : e}`);
    await admin.end();
    return;
  }
  const second = await uploadBooksInboxFiles(OMAR, company.clientId, [{ ...file, filename: "copy.pdf" }]);

  assert.equal(first.results[0].duplicate, false);
  assert.equal(second.results[0].duplicate, true);
  assert.equal(second.results[0].inboxItemId, first.results[0].inboxItemId, "points at the original item");
  assert.equal(second.results[0].filename, "copy.pdf");

  const rows = await admin.query(
    `SELECT i.status, i.error FROM books_inbox_items i
     JOIN books_files f ON f.id = i.file_id
     WHERE f.sha256 = $1 AND i.client_id = $2`,
    [first.results[0].sha256, company.clientId],
  );
  assert.equal(rows.rowCount, 1, "no junk 'failed' duplicate row");
  assert.notEqual(rows.rows[0].status, "failed");

  const jobs = await admin.query(
    `SELECT 1 FROM books_jobs WHERE client_id = $1 AND kind = 'extract_document'`,
    [company.clientId],
  );
  assert.equal(jobs.rowCount, 1, "duplicate does not enqueue another extraction");
  await admin.end();
});

test("the same file in another company is a new upload, not a duplicate (hash unique per company)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  const a = await createTestCompany(admin, "upload-dup-company-a");
  const b = await createTestCompany(admin, "upload-dup-company-b");
  const bytes = uniquePdf("cross");
  if (!bytes) {
    t.skip("invoice_02.pdf missing");
    await admin.end();
    return;
  }
  const file = { filename: "invoice_02.pdf", contentType: "application/pdf", bytes };

  let inA: Awaited<ReturnType<typeof uploadBooksInboxFiles>>;
  try {
    inA = await uploadBooksInboxFiles(OMAR, a.clientId, [file]);
  } catch (e) {
    t.skip(`upload unavailable (MinIO?): ${e instanceof Error ? e.message : e}`);
    await admin.end();
    return;
  }
  const inB = await uploadBooksInboxFiles(OMAR, b.clientId, [file]);

  assert.equal(inA.results[0].duplicate, false);
  assert.equal(inB.results[0].duplicate, false);
  assert.notEqual(inB.results[0].fileId, inA.results[0].fileId);
  const files = await admin.query(`SELECT client_id FROM books_files WHERE sha256 = $1`, [inA.results[0].sha256]);
  assert.equal(files.rowCount, 2);
  await admin.end();
});
