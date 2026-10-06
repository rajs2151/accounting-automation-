/**
 * P2B-4 (C4): "This month" dashboard checklist + issues list. Synthetic data only.
 */
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { materializeBooksBankTransactions } from "@/server/books/bank-transactions";
import { setCompanyVatSettings } from "@/server/books/company-vat-settings";
import { getBooksMonthChecklist, listBooksIssues, vatPeriodForMonth } from "@/server/books/dashboard";
import { createBooksDocument } from "@/server/books/documents";
import { createBooksParty } from "@/server/books/parties";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";
const RAJ = "77777777-7777-4777-8777-777777777777";

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
  const ready = await admin.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'clients' AND column_name = 'vat_return_frequency'`,
  );
  if (!ready.rowCount) {
    t.skip("db/52 not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("P2B-4: VAT tax period + due date (28 days after period end)", () => {
  assert.deepEqual(vatPeriodForMonth("2026-05-31", "monthly"), {
    periodStart: "2026-05-01",
    periodEnd: "2026-05-31",
    dueDate: "2026-06-28",
  });
  // Quarters ending Mar/Jun/Sep/Dec.
  assert.deepEqual(vatPeriodForMonth("2026-05-31", "quarterly", 3), {
    periodStart: "2026-04-01",
    periodEnd: "2026-06-30",
    dueDate: "2026-07-28",
  });
  // Quarters ending Feb/May/Aug/Nov — May closes a quarter.
  assert.deepEqual(vatPeriodForMonth("2026-05-31", "quarterly", 11), {
    periodStart: "2026-03-01",
    periodEnd: "2026-05-31",
    dueDate: "2026-06-28",
  });
  // Quarter crossing the year end (Jan/Apr/Jul/Oct stagger).
  assert.deepEqual(vatPeriodForMonth("2026-11-30", "quarterly", 1), {
    periodStart: "2026-11-01",
    periodEnd: "2027-01-31",
    dueDate: "2027-02-28",
  });
  assert.deepEqual(vatPeriodForMonth("2027-01-31", "quarterly", 4), {
    periodStart: "2026-11-01",
    periodEnd: "2027-01-31",
    dueDate: "2027-02-28",
  });
  assert.throws(() => vatPeriodForMonth("2026-05-31", "quarterly", null), /vat_stagger_invalid/);
});

async function file(admin: pg.Client, clientId: string | null, name: string) {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,'application/pdf',10,$6)`,
    [id, clientId, `p2b4-${randomUUID()}`, `books/x/${id}/f.pdf`, name, OMAR],
  );
  return id;
}

async function statement(
  admin: pg.Client,
  company: TestCompany,
  accountId: string,
  from: string,
  to: string,
  flags: string,
  lines: Array<{ date: string; credit: number }>,
) {
  const fileId = await file(admin, company.clientId, `stmt-${from}.csv`);
  const id = randomUUID();
  const closing = lines.reduce((s, l) => s + l.credit, 0);
  await admin.query(
    `INSERT INTO books_statement_extractions (
       id, client_id, file_id, account_id, period_from, period_to,
       opening_balance_minor, closing_balance_minor, status, validation_flags
     ) VALUES ($1,$2,$3,$4,$5,$6,0,$7,'ready',$8::jsonb)`,
    [id, company.clientId, fileId, accountId, from, to, closing, flags],
  );
  let i = 0;
  for (const l of lines) {
    await admin.query(
      `INSERT INTO books_statement_lines (id, statement_id, client_id, line_date, description, credit_minor, sort_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), id, company.clientId, l.date, `Line ${i}`, l.credit, i++],
    );
  }
  return id;
}

test("P2B-4: checklist cards and issues for a month", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  let unassignedInbox: string | null = null;
  try {
    const company = await createTestCompany(admin, "p2b4-dash");
    const clientId = company.clientId;
    const may = company.periods["May 2026"];
    const aed = company.accountIdByCode["1120"];
    const usd = company.accountIdByCode["1121"];
    await admin.query(
      `UPDATE books_accounts SET bank_name = 'P2B4', iban = 'AE070331234567890123456' WHERE id = $1`,
      [aed],
    );

    // 1120: whole May covered (two adjacent statements); 1121: only to 15 May.
    await statement(admin, company, aed, "2026-05-01", "2026-05-15", '["balance_ok"]', [
      { date: "2026-05-03", credit: 10000 },
    ]);
    await statement(admin, company, aed, "2026-05-16", "2026-05-31", '["balance_ok"]', [
      { date: "2026-05-20", credit: 5000 },
    ]);
    await statement(admin, company, usd, "2026-05-01", "2026-05-15", '["closing_mismatch"]', [
      { date: "2026-05-04", credit: 700 },
    ]);
    await materializeBooksBankTransactions(OMAR, clientId);
    const [firstTxn] = (
      await admin.query(
        `SELECT id FROM books_bank_transactions WHERE client_id = $1 AND account_id = $2 ORDER BY txn_date LIMIT 1`,
        [clientId, aed],
      )
    ).rows;
    await admin.query(`UPDATE books_bank_transactions SET review_status = 'ready' WHERE id = $1`, [firstTxn.id]);

    // Drafts + inbox review items + one failed extraction.
    const supplier = await createBooksParty(OMAR, clientId, {
      partyType: "supplier",
      name: `P2B4 Supplier ${Date.now()}`,
      trn: "100000000000041",
      force: true,
    });
    await createBooksDocument(OMAR, clientId, {
      docType: "purchase_bill",
      partyId: String(supplier.id),
      issueDate: "2026-05-10",
      periodId: may,
      documentNumber: `P2B4-B-${Date.now()}`,
      lines: [{ description: "Rent", lineKind: "expense", vatCode: "SR", netMinor: 1000, vatMinor: 50 }],
    });
    const billFile = await file(admin, clientId, "bill.pdf");
    await admin.query(
      `INSERT INTO books_inbox_items (client_id, file_id, intended_type, status) VALUES ($1,$2,'purchase_bill','needs_review')`,
      [clientId, billFile],
    );
    const salesFile = await file(admin, clientId, "inv.pdf");
    await admin.query(
      `INSERT INTO books_inbox_items (client_id, file_id, intended_type, status) VALUES ($1,$2,'sales_invoice','needs_review')`,
      [clientId, salesFile],
    );
    const badFile = await file(admin, clientId, "blurry.jpg");
    const failed = await admin.query(
      `INSERT INTO books_inbox_items (client_id, file_id, status, error) VALUES ($1,$2,'failed','ocr_failed') RETURNING id`,
      [clientId, badFile],
    );

    const unassignedBefore = (await getBooksMonthChecklist(OMAR, clientId, { periodId: may })).unassignedInbox
      .count;
    const looseFile = await file(admin, null, "unknown.pdf");
    unassignedInbox = String(
      (
        await admin.query(
          `INSERT INTO books_inbox_items (client_id, file_id, status) VALUES (NULL,$1,'needs_review') RETURNING id`,
          [looseFile],
        )
      ).rows[0].id,
    );

    const c = await getBooksMonthChecklist(OMAR, clientId, { periodId: may, today: "2026-06-01" });
    assert.equal(c.period.label, "May 2026");
    assert.equal(c.period.end, "2026-05-31");

    const byCode = Object.fromEntries(c.statements.accounts.map((a) => [a.code, a.state]));
    assert.equal(byCode["1120"], "covered", "adjacent statements cover the month");
    assert.equal(byCode["1121"], "gap");
    assert.equal(byCode["1110"], "missing");
    assert.equal(byCode["6900"], undefined, "expense accounts with sub_type 'bank' are not money accounts");
    assert.equal(byCode["6910"], undefined);
    assert.equal(c.statements.ok, false);

    assert.equal(c.documentsToReview.purchaseBills, 2, "1 draft + 1 inbox upload");
    assert.equal(c.documentsToReview.salesInvoices, 1);
    assert.equal(c.documentsToReview.notes, 0);
    assert.equal(c.documentsToReview.count, 3);

    // 1120 second line + the USD line (C3 materialises any 'ready' statement, even with a flag).
    assert.equal(c.bankLines.needsReview, 2);
    assert.equal(c.bankLines.readyNotPosted, 1);
    assert.equal(c.unassignedInbox.count, unassignedBefore + 1);

    assert.equal(c.periodStatus.locked, false);
    assert.deepEqual(c.periodStatus.vat, { set: false });

    const issues = await listBooksIssues(OMAR, clientId, { periodId: may });
    const kinds = issues.map((i) => i.kind).sort();
    assert.deepEqual(kinds, ["bank_recon_difference", "failed_extraction", "statement_balance_check"]);
    assert.ok(issues.some((i) => i.refId === String(failed.rows[0].id)));
    assert.equal(c.issues.count, 3);

    // VAT stagger: admin only, audited; due date follows the stagger.
    await assert.rejects(
      setCompanyVatSettings(OMAR, clientId, { vatReturnFrequency: "quarterly", vatPeriodEndMonth: 3 }),
      /vat_settings_require_admin/,
    );
    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [RAJ, clientId],
    );
    await assert.rejects(
      setCompanyVatSettings(RAJ, clientId, { vatReturnFrequency: "quarterly", vatPeriodEndMonth: 13 }),
      /vat_stagger_invalid/,
    );
    await setCompanyVatSettings(RAJ, clientId, { vatReturnFrequency: "quarterly", vatPeriodEndMonth: 3 });
    const withVat = await getBooksMonthChecklist(OMAR, clientId, { periodId: may, today: "2026-07-01" });
    assert.deepEqual(withVat.periodStatus.vat, {
      set: true,
      frequency: "quarterly",
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      dueDate: "2026-07-28",
      daysUntilDue: 27,
    });
    const audit = await admin.query(
      `SELECT after_json FROM books_audit_events WHERE client_id = $1 AND action = 'set_vat_settings'`,
      [clientId],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].after_json.vatPeriodEndMonth, 3);

    await admin.query(`UPDATE books_periods SET status = 'LOCKED' WHERE id = $1`, [may]);
    const locked = await getBooksMonthChecklist(OMAR, clientId, { periodId: may });
    assert.equal(locked.periodStatus.locked, true);
    await admin.query(`UPDATE books_periods SET status = 'OPEN' WHERE id = $1`, [may]);
  } finally {
    if (unassignedInbox) {
      await admin.query(`DELETE FROM books_inbox_items WHERE id = $1`, [unassignedInbox]).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  }
});
