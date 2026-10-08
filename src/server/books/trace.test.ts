/**
 * ING-5b: Trace chain for a posted sales invoice (Omar confirm → Layla approve).
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import {
  approveAndPostBooksDocument,
} from "@/server/books/documents";
import {
  confirmInboxAsDocument,
  uploadBooksInboxFiles,
} from "@/server/books/inbox";
import { createBooksParty } from "@/server/books/parties";
import { createTestCompany } from "@/server/books/test-company";
import { workerInvoiceFieldsJson } from "@/server/books/test-fixtures/worker-extraction";
import { traceBooksDocument } from "@/server/books/trace";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const ING5 = path.join(process.cwd(), "fixtures/extraction/ing5");

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

async function ensureBucket() {
  const { CreateBucketCommand, HeadBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT || "http://minio:9000",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || "daftar",
      secretAccessKey: process.env.S3_SECRET_KEY || "daftar-local-only",
    },
  });
  const bucket = process.env.S3_BUCKET || "statements";
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch {
      /* ignore */
    }
  }
}

test("ING-5b: traceBooksDocument shows upload→journal with Omar/Layla and exact fils", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  const pdf = path.join(ING5, "pdfs", "sales_tax_invoice.pdf");
  if (!fs.existsSync(pdf)) {
    t.skip("ING-5 fixtures missing");
    await admin.end();
    return;
  }

  let company: Awaited<ReturnType<typeof createTestCompany>>;
  try {
    company = await createTestCompany(admin, `ing5-trace-${Date.now()}`);
  } catch (e) {
    t.skip(`createTestCompany failed: ${e instanceof Error ? e.message : e}`);
    await admin.end();
    return;
  }
  const clientId = company.clientId;
  const may = company.periods["May 2026"];
  assert.ok(may);

  try {
    await ensureBucket();
    const customer = await createBooksParty(OMAR, clientId, {
      partyType: "customer",
      name: `Trace Cust ${Date.now()}`,
      trn: "100123456700003",
      force: true,
    });

    const base = fs.readFileSync(pdf);
    const bytes = Buffer.concat([base, Buffer.from(`\n%trace-${Date.now()}-${randomUUID()}`)]);
    const uploaded = await uploadBooksInboxFiles(
      OMAR,
      clientId,
      [{ filename: "sales_tax_invoice.pdf", contentType: "application/pdf", bytes }],
      { intendedType: "sales_invoice" },
    );
    const inboxId = String(uploaded.results[0]!.inboxItemId);
    const fileId = String(uploaded.results[0]!.fileId);
    assert.equal(uploaded.results[0]!.duplicate, false);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), uploaded.results[0]!.sha256);

    const extractionId = randomUUID();
    await admin.query(
      `INSERT INTO books_extractions (
         id, client_id, file_id, inbox_item_id, doc_type, status,
         fields_json, raw_text, word_boxes, validation_flags, extractor_version
       ) VALUES ($1,$2,$3,$4,'sales_invoice','needs_review',$5::jsonb,'','[]'::jsonb,'[]'::jsonb,'ing5-trace')`,
      [
        extractionId,
        clientId,
        fileId,
        inboxId,
        JSON.stringify(
          workerInvoiceFieldsJson({
            invoiceNo: `INV-TRACE-${Date.now()}`,
            invoiceDate: "2026-05-15",
            netMinor: 1_000_000,
            vatMinor: 50_000,
            grossMinor: 1_050_000,
            lineVatCode: "SR",
          }),
        ),
      ],
    );
    await admin.query(
      `UPDATE books_inbox_items SET status = 'needs_review', detected_type = 'sales_invoice' WHERE id = $1`,
      [inboxId],
    );

    const confirmed = await confirmInboxAsDocument(OMAR, clientId, inboxId, {
      partyId: String(customer.id),
      periodId: may,
      docType: "sales_invoice",
      issueDate: "2026-05-15",
    });
    const docId = String(confirmed.documentId);
    await approveAndPostBooksDocument(LAYLA, clientId, docId);

    const byDoc = await traceBooksDocument(OMAR, clientId, docId);
    assert.equal(byDoc.kind, "document");
    assert.equal(byDoc.id, docId);

    const keys = byDoc.steps.map((s) => s.key);
    assert.ok(keys.includes("uploaded"));
    assert.ok(keys.includes("extraction"));
    assert.ok(keys.includes("document"));
    assert.ok(keys.includes("journal"));
    assert.ok(keys.includes("open_item"));

    const uploadedStep = byDoc.steps.find((s) => s.key === "uploaded")!;
    assert.equal(uploadedStep.status, "done");
    assert.ok(uploadedStep.actors.some((a) => a.id === OMAR));

    const docStep = byDoc.steps.find((s) => s.key === "document")!;
    assert.equal(docStep.status, "done");
    assert.ok(docStep.actors.some((a) => a.id === OMAR));
    assert.ok(docStep.actors.some((a) => a.id === LAYLA));

    const journal = byDoc.steps.find((s) => s.key === "journal")!;
    assert.equal(journal.status, "done");
    const lines = journal.detail.lines as Array<{
      code: string;
      debitMinor: number;
      creditMinor: number;
    }>;
    const byCode = Object.fromEntries(lines.map((l) => [l.code, l]));
    assert.equal(byCode["1210"]?.debitMinor, 1_050_000);
    assert.equal(byCode["4100"]?.creditMinor, 1_000_000);
    assert.equal(byCode["2210"]?.creditMinor, 50_000);

    const oi = byDoc.steps.find((s) => s.key === "open_item")!;
    assert.equal(Number(oi.detail.openAedMinor), 1_050_000);

    const balanced = byDoc.tieOuts.find((t) => t.key === "journal_balanced");
    assert.equal(balanced?.ok, true);

    // Resolve by inbox id and by document number.
    const byInbox = await traceBooksDocument(OMAR, clientId, inboxId);
    assert.equal(byInbox.id, docId);
    const docNo = String(docStep.detail.documentNumber || "");
    if (docNo) {
      const byNo = await traceBooksDocument(OMAR, clientId, docNo);
      assert.equal(byNo.id, docId);
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
});
