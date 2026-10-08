import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { BooksError } from "@/server/books/errors";
import { splitInboxPdfSnippets } from "@/server/books/inbox";
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
  const col = await admin.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'books_inbox_items' AND column_name = 'page_start'`,
  );
  if (!col.rowCount) {
    t.skip("db/63 page snippets not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("splitInboxPdfSnippets creates children, routes parent, enqueues extract jobs", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;

  const company = await createTestCompany(admin, "inbox-split-pages");
  const clientId = company.clientId;
  const fileId = randomUUID();
  const parentId = randomUUID();

  await admin.query(
    `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
     VALUES ($1,$2,$3,$4,'multi.pdf','application/pdf',10,$5)`,
    [fileId, clientId, randomUUID().replace(/-/g, ""), `books/${clientId}/${fileId}/multi.pdf`, OMAR],
  );
  await admin.query(
    `INSERT INTO books_inbox_items (id, client_id, file_id, status, intended_type)
     VALUES ($1,$2,$3,'needs_review','purchase_bill')`,
    [parentId, clientId, fileId],
  );

  const result = await splitInboxPdfSnippets(OMAR, clientId, parentId, {
    ranges: [
      { pageStart: 1, pageEnd: 1 },
      { pageStart: 2, pageEnd: 3 },
    ],
    pageCount: 3,
  });

  assert.equal(result.status, "routed");
  assert.equal(result.children.length, 2);
  assert.equal(result.children[0].pageStart, 1);
  assert.equal(result.children[1].pageEnd, 3);

  const parent = await admin.query(`SELECT status FROM books_inbox_items WHERE id = $1`, [parentId]);
  assert.equal(parent.rows[0].status, "routed");

  const kids = await admin.query(
    `SELECT id, page_start, page_end, file_id, parent_inbox_item_id, status
     FROM books_inbox_items WHERE parent_inbox_item_id = $1 ORDER BY page_start`,
    [parentId],
  );
  assert.equal(kids.rowCount, 2);
  assert.equal(String(kids.rows[0].file_id), fileId);
  assert.equal(kids.rows[0].status, "queued");

  const jobs = await admin.query(
    `SELECT payload FROM books_jobs
     WHERE client_id = $1 AND kind = 'extract_document'
       AND payload->>'pageStart' IS NOT NULL`,
    [clientId],
  );
  assert.ok((jobs.rowCount || 0) >= 2);

  await assert.rejects(
    () =>
      splitInboxPdfSnippets(OMAR, clientId, parentId, {
        ranges: [
          { pageStart: 1, pageEnd: 1 },
          { pageStart: 2, pageEnd: 2 },
        ],
        pageCount: 3,
      }),
    (e: unknown) => e instanceof BooksError && e.message === "cannot_split_status",
  );

  await assert.rejects(
    () =>
      splitInboxPdfSnippets(OMAR, clientId, result.children[0].id, {
        ranges: [
          { pageStart: 1, pageEnd: 1 },
          { pageStart: 2, pageEnd: 2 },
        ],
        pageCount: 2,
      }),
    (e: unknown) => e instanceof BooksError && e.message === "cannot_split_snippet_child",
  );

  await admin.end();
});

test("splitInboxPdfSnippets rejects overlapping and single ranges", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;

  const company = await createTestCompany(admin, "inbox-split-reject");
  const clientId = company.clientId;
  const fileId = randomUUID();
  const parentId = randomUUID();
  await admin.query(
    `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
     VALUES ($1,$2,$3,$4,'x.pdf','application/pdf',10,$5)`,
    [fileId, clientId, randomUUID().replace(/-/g, ""), `books/${clientId}/${fileId}/x.pdf`, OMAR],
  );
  await admin.query(
    `INSERT INTO books_inbox_items (id, client_id, file_id, status)
     VALUES ($1,$2,$3,'needs_review')`,
    [parentId, clientId, fileId],
  );

  await assert.rejects(
    () =>
      splitInboxPdfSnippets(OMAR, clientId, parentId, {
        ranges: [{ pageStart: 1, pageEnd: 1 }],
        pageCount: 2,
      }),
    (e: unknown) => e instanceof BooksError && e.message === "ranges_require_at_least_two",
  );

  await assert.rejects(
    () =>
      splitInboxPdfSnippets(OMAR, clientId, parentId, {
        ranges: [
          { pageStart: 1, pageEnd: 2 },
          { pageStart: 2, pageEnd: 3 },
        ],
        pageCount: 3,
      }),
    (e: unknown) => e instanceof BooksError && e.message === "overlapping_ranges",
  );

  await admin.end();
});
