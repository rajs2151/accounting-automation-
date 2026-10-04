import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import { getBooksInboxReview, uploadBooksInboxFiles } from "@/server/books/inbox";
import { BooksError } from "@/server/books/errors";
import { parseInvoiceFieldsFromText, pdfTextFromStreams } from "@/server/books/extract-sync";

const OMAR = "55555555-5555-4555-8555-555555555555";
const DESERT = "e1000001-0000-4000-8000-000000000001";

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

test("parseInvoiceFieldsFromText reads INV-SYN-002 from fixture text", () => {
  const text = fs.readFileSync(
    path.join(process.cwd(), "fixtures/extraction/text/invoice_02.txt"),
    "utf8",
  );
  const parsed = parseInvoiceFieldsFromText(text, "invoice_02.pdf");
  assert.equal(parsed.invoiceNo, "INV-SYN-002");
  assert.equal(parsed.fields.invoice_no.value, "INV-SYN-002");
  assert.equal(parsed.grandMinor, 10500);
});

test("pdfTextFromStreams reads INV-SYN-002 from fixture PDF", () => {
  const bytes = fs.readFileSync(
    path.join(process.cwd(), "fixtures/extraction/pdfs/invoice_02.pdf"),
  );
  const text = pdfTextFromStreams(bytes);
  assert.match(text, /INV-SYN-002/);
  const parsed = parseInvoiceFieldsFromText(text, "invoice_02.pdf");
  assert.equal(parsed.invoiceNo, "INV-SYN-002");
});

test("review API returns books_extractions for uploaded inbox id; 404 for unknown", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;

  const unknown = randomUUID();
  await assert.rejects(
    () => getBooksInboxReview(OMAR, DESERT, unknown),
    (err: unknown) => err instanceof BooksError && err.code === "not_found",
  );

  const pdfPath = path.join(process.cwd(), "fixtures/extraction/pdfs/invoice_02.pdf");
  if (!fs.existsSync(pdfPath)) {
    t.skip("invoice_02.pdf missing");
    await admin.end();
    return;
  }
  // Unique bytes so sha256 does not collide with prior runs
  const base = fs.readFileSync(pdfPath);
  const bytes = Buffer.concat([base, Buffer.from(`\n%slice1-${Date.now()}`)]);

  let uploaded: Awaited<ReturnType<typeof uploadBooksInboxFiles>>;
  try {
    uploaded = await uploadBooksInboxFiles(OMAR, DESERT, [
      { filename: "invoice_02.pdf", contentType: "application/pdf", bytes },
    ]);
  } catch (e) {
    t.skip(`upload unavailable (MinIO?): ${e instanceof Error ? e.message : e}`);
    await admin.end();
    return;
  }

  const inboxId = uploaded.results[0]?.inboxItemId;
  assert.ok(inboxId);

  const review = await getBooksInboxReview(OMAR, DESERT, inboxId);
  assert.equal(review.id, inboxId);
  assert.ok(review.extractionId, "extraction row required");
  assert.equal(String((review.fieldsJson as { invoice_no?: { value?: string } }).invoice_no?.value), "INV-SYN-002");
  assert.equal(review.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.match(String(review.fileUrl), /^https?:\/\//);

  await admin.end();
});
