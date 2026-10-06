import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import {
  listStatementExtractions,
  statementListBalanceCheck,
} from "@/server/books/statement-extractions";
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
  const ready = await admin.query(`SELECT to_regclass('books_statement_extractions') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("phase1 schema not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("statementListBalanceCheck maps flags and status", () => {
  assert.equal(statementListBalanceCheck([], "queued"), null);
  assert.equal(statementListBalanceCheck([], "extracting"), null);
  assert.equal(statementListBalanceCheck(["balance_ok"], "ready"), "ok");
  assert.equal(statementListBalanceCheck(["closing_mismatch"], "needs_review"), "failed");
  assert.equal(statementListBalanceCheck(["running_balance_break"], "needs_review"), "failed");
  assert.equal(statementListBalanceCheck([], "needs_review"), "ok");
  assert.equal(statementListBalanceCheck([], "failed"), "failed");
});

test("bank_statement upload stores intended_type and passes userDocType in job", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;

  const company = await createTestCompany(admin, "stmt-upload-userdoctype");
  const clientId = company.clientId;
  const pdfPath = path.join(process.cwd(), "fixtures/extraction/pdfs/bank_a.pdf");
  if (!fs.existsSync(pdfPath)) {
    t.skip("bank_a.pdf missing");
    await admin.end();
    return;
  }
  const bytes = Buffer.concat([
    fs.readFileSync(pdfPath),
    Buffer.from(`\n%stmt-up-${Date.now()}-${Math.random()}\n`),
  ]);

  let uploaded: Awaited<ReturnType<typeof uploadBooksInboxFiles>>;
  try {
    uploaded = await uploadBooksInboxFiles(
      OMAR,
      clientId,
      [{ filename: "bank_a.pdf", contentType: "application/pdf", bytes }],
      { intendedType: "bank_statement", userDocType: "bank_statement" },
    );
  } catch (e) {
    t.skip(`upload unavailable (MinIO?): ${e instanceof Error ? e.message : e}`);
    await admin.end();
    return;
  }

  const inboxId = uploaded.results[0]?.inboxItemId;
  assert.ok(inboxId);
  assert.equal(uploaded.results[0].status, "queued");

  const inbox = await admin.query(
    `SELECT intended_type, status FROM books_inbox_items WHERE id = $1`,
    [inboxId],
  );
  assert.equal(inbox.rows[0].intended_type, "bank_statement");
  assert.equal(inbox.rows[0].status, "queued");

  const jobs = await admin.query(
    `SELECT payload FROM books_jobs
     WHERE client_id = $1 AND kind = 'extract_document'
       AND payload->>'inboxItemId' = $2`,
    [clientId, inboxId],
  );
  assert.equal(jobs.rowCount, 1);
  assert.equal(jobs.rows[0].payload.userDocType, "bank_statement");

  // C2-2: row upload persists intended_account_id + job accountId when account is set up.
  const bank = (
    await admin.query(
      `SELECT id FROM books_accounts WHERE client_id = $1 AND code = '1120'`,
      [clientId],
    )
  ).rows[0];
  if (bank) {
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'Test Bank', iban = 'AE070331234567890123456',
         iban_last4 = '3456' WHERE id = $1`,
      [bank.id],
    );
    const bytes2 = Buffer.concat([
      fs.readFileSync(pdfPath),
      Buffer.from(`\n%stmt-acc-${Date.now()}-${Math.random()}\n`),
    ]);
    const withAcc = await uploadBooksInboxFiles(
      OMAR,
      clientId,
      [{ filename: "bank_a_acc.pdf", contentType: "application/pdf", bytes: bytes2 }],
      {
        intendedType: "bank_statement",
        userDocType: "bank_statement",
        accountId: String(bank.id),
      },
    );
    const inbox2 = withAcc.results[0]?.inboxItemId;
    assert.ok(inbox2);
    const row = await admin.query(
      `SELECT intended_account_id FROM books_inbox_items WHERE id = $1`,
      [inbox2],
    );
    assert.equal(String(row.rows[0].intended_account_id), String(bank.id));
    const job2 = await admin.query(
      `SELECT payload FROM books_jobs
       WHERE client_id = $1 AND kind = 'extract_document'
         AND payload->>'inboxItemId' = $2`,
      [clientId, inbox2],
    );
    assert.equal(String(job2.rows[0].payload.accountId), String(bank.id));
  }

  const list = await listStatementExtractions(OMAR, clientId);
  const pending = list.find((r: { id: string }) => r.id === inboxId) as
    | {
        status: string;
        filename: string;
        lineCount: number;
        balanceCheck: string | null;
        rowKind: string;
      }
    | undefined;
  assert.ok(pending, "pending upload should appear on statements list");
  assert.equal(pending.status, "queued");
  assert.equal(pending.filename, "bank_a.pdf");
  assert.equal(pending.lineCount, 0);
  assert.equal(pending.balanceCheck, null);
  assert.equal(pending.rowKind, "pending");

  await admin.end();
});

test("listStatementExtractions includes filename, lineCount, balanceCheck", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;

  const company = await createTestCompany(admin, "stmt-list-cols");
  const clientId = company.clientId;
  const fileId = randomUUID();
  const stmtId = randomUUID();
  const sha = randomUUID().replace(/-/g, "");

  await admin.query(
    `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
     VALUES ($1,$2,$3,$4,'bank_list.pdf','application/pdf',10,$5)`,
    [fileId, clientId, sha, `synthetic/${fileId}.pdf`, OMAR],
  );
  await admin.query(
    `INSERT INTO books_statement_extractions (
       id, client_id, file_id, bank_name, iban, currency,
       period_from, period_to, opening_balance_minor, closing_balance_minor,
       status, validation_flags
     ) VALUES ($1,$2,$3,'Synthetic UAE Bank A','AE070331234567890123456','AED',
               '2026-05-01','2026-05-31',100000,130000,'ready','["balance_ok"]'::jsonb)`,
    [stmtId, clientId, fileId],
  );
  await admin.query(
    `INSERT INTO books_statement_lines (
       id, statement_id, client_id, line_date, description,
       debit_minor, credit_minor, running_balance_minor, currency, sort_index
     ) VALUES
       ($1,$2,$3,'2026-05-05','CLIENT RECEIPT',0,50000,150000,'AED',0),
       ($4,$2,$3,'2026-05-10','OFFICE RENT',20000,0,130000,'AED',1)`,
    [randomUUID(), stmtId, clientId, randomUUID()],
  );

  const list = await listStatementExtractions(OMAR, clientId);
  const row = list.find((r: { id: string }) => r.id === stmtId) as
    | {
        filename: string;
        lineCount: number;
        balanceCheck: string | null;
        openingBalanceMinor: number;
        periodFrom: string | Date;
      }
    | undefined;
  assert.ok(row);
  assert.equal(row.filename, "bank_list.pdf");
  assert.equal(row.lineCount, 2);
  assert.equal(row.balanceCheck, "ok");
  assert.equal(row.openingBalanceMinor, 100000);

  await admin.end();
});
