import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import {
  approveAndPostBooksDocument,
  createBooksDocument,
} from "@/server/books/documents";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const DESERT = "e1000001-0000-4000-8000-000000000001";
const ROOT = path.resolve(
  process.cwd(),
  "fixtures/books-goldens/company-a/expected/month-1-journals.json",
);

type GoldenLine = { code: string; debitMinor: number; creditMinor: number };
type GoldenDoc = {
  documentNumber: string;
  docType: "sales_invoice" | "purchase_bill";
  partyId: string;
  issueDate: string;
  lines: Array<{
    description?: string;
    lineKind?: "revenue" | "disbursement" | "expense";
    vatCode?: string;
    netMinor: number;
    vatMinor?: number;
  }>;
  expectedJournalLines: GoldenLine[];
};

test("company A month-1 golden harness", async (t) => {
  if (!existsSync(ROOT)) {
    t.skip("golden file missing");
    return;
  }
  const expected = JSON.parse(readFileSync(ROOT, "utf8")) as {
    _todo?: string;
    _provisional?: boolean;
    documents?: GoldenDoc[];
    journals?: unknown[];
  };
  if (expected._todo || expected._provisional || !expected.documents?.length) {
    t.skip(
      expected._provisional
        ? "PROVISIONAL golden — awaiting owner hand-computed expected journals"
        : "Company A month-1 expected journals not yet supplied",
    );
    return;
  }

  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const adminUrl = process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres unreachable");
    return;
  }

  try {
    const ready = await admin.query(`SELECT to_regclass('books_documents') AS t`);
    if (!ready.rows[0]?.t) {
      t.skip("phase1 schema not migrated");
      return;
    }
    const period = await admin.query(
      `SELECT id FROM books_periods WHERE client_id = $1 AND label = 'May 2026'`,
      [DESERT],
    );
    if (!period.rowCount) {
      t.skip("May 2026 period missing");
      return;
    }
    const periodId = String(period.rows[0].id);

    for (const doc of expected.documents) {
      // Idempotent: soft-void prior golden docs with same number so re-runs stay clean
      await admin.query(
        `UPDATE books_documents SET deleted_at = now(), status = 'void'
         WHERE client_id = $1 AND document_number = $2 AND deleted_at IS NULL`,
        [DESERT, doc.documentNumber],
      );

      const created = await createBooksDocument(OMAR, DESERT, {
        docType: doc.docType,
        partyId: doc.partyId,
        issueDate: doc.issueDate,
        periodId,
        documentNumber: doc.documentNumber,
        forceDuplicate: true,
        lines: doc.lines,
      });
      const posted = await approveAndPostBooksDocument(LAYLA, DESERT, String(created.id));

      const rows = await admin.query(
        `SELECT a.code, l.debit_minor::bigint AS d, l.credit_minor::bigint AS c
         FROM books_journal_lines l
         JOIN books_accounts a ON a.id = l.account_id
         WHERE l.entry_id = $1
         ORDER BY a.code, l.debit_minor DESC`,
        [posted.journalEntryId],
      );
      assert.equal(
        rows.rowCount,
        doc.expectedJournalLines.length,
        `${doc.documentNumber}: line count (got ${rows.rows.map((r) => `${r.code}:${r.d}/${r.c}`).join(",")})`,
      );
      for (const line of doc.expectedJournalLines) {
        const hit = rows.rows.find(
          (r) =>
            r.code === line.code &&
            Number(r.d) === line.debitMinor &&
            Number(r.c) === line.creditMinor,
        );
        assert.ok(
          hit,
          `${doc.documentNumber}: missing ${line.code} ${line.debitMinor}/${line.creditMinor}; got ${rows.rows
            .map((r) => `${r.code}:${r.d}/${r.c}`)
            .join(",")}`,
        );
      }
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
});
