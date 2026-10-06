import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

import {
  createBooksJournal,
  listBooksJournals,
  postBooksJournal,
  reverseBooksJournal,
  updateBooksJournalMemo,
  updateBooksJournalNote,
  updateBooksJournalTags,
} from "./journals";
import { lockBooksPeriod, reopenBooksPeriod } from "./periods";
import { listBooksAudit } from "./audit";
import { booksCoaTree, listBooksAccounts } from "./accounts";
import { BooksError } from "./errors";
import { createTestCompany } from "./test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const A_ONLY = "e5000001-0000-4000-8000-000000000001";
const PARENT_CASH = "1100"; // Cash & Bank header (non-postable) under COA v2

async function createThenPost(
  clientId: string,
  periodId: string,
  bank: string,
  revenue: string,
  body: Omit<Parameters<typeof createBooksJournal>[2], "periodId" | "post" | "lines"> & {
    lines?: Parameters<typeof createBooksJournal>[2]["lines"];
  },
) {
  const lines = body.lines ?? [
    { accountId: bank, debitMinor: 777 },
    { accountId: revenue, creditMinor: 777 },
  ];
  const { lines: _ignored, ...rest } = body;
  const draft = await createBooksJournal(OMAR, clientId, { ...rest, periodId, lines, post: false });
  const posted = await postBooksJournal(LAYLA, clientId, draft.id);
  return { ...draft, ...posted, id: draft.id, status: "posted" as const };
}

function appUrl() {
  return process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
}

function adminUrl() {
  const url = appUrl();
  return process.env.DATABASE_URL_SUPER || url.replace("://daftar_app:", "://daftar:");
}

async function connectAdmin(t: test.TestContext) {
  process.env.DATABASE_URL = appUrl();
  const admin = new pg.Client({ connectionString: adminUrl() });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return null;
  }
  const ready = await admin.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'books_entry_sequences'`,
  );
  if (!ready.rowCount) {
    t.skip("books phase0 schema not migrated (18)");
    await admin.end();
    return null;
  }
  return admin;
}

async function tempPeriod(admin: pg.Client, clientId: string, label: string) {
  const row = await admin.query(
    `INSERT INTO books_periods (client_id, label, period_start, period_end, status)
     VALUES ($1,$2,'2026-09-01','2026-09-30','OPEN') RETURNING id`,
    [clientId, label],
  );
  return String(row.rows[0].id);
}

test("1 SQL-level unbalanced post is rejected by balance trigger", async (t) => {
  const admin = await connectAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p0-sql-unbal");
    const clientId = company.clientId;
    const bank = company.accountIdByCode["1120"];
    const revenue = company.accountIdByCode["4100"];
    assert.ok(bank && revenue);
    const periodId = await tempPeriod(admin, clientId, `sql-unbal-${Date.now()}`);
    const entryId = randomUUID();
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO books_journal_entries (
         id, client_id, period_id, memo, entry_date, status, content_hash, created_by
       ) VALUES ($1,$2,$3,'sql-unbal','2026-09-02','draft','x',$4)`,
      [entryId, clientId, periodId, OMAR],
    );
    await admin.query(
      `INSERT INTO books_journal_lines (entry_id, client_id, account_id, debit_minor, credit_minor)
       VALUES ($1,$2,$3,100,0), ($1,$2,$4,0,40)`,
      [entryId, clientId, bank, revenue],
    );
    await admin.query(`UPDATE books_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`, [
      entryId,
    ]);
    // Balance trigger is DEFERRABLE — fires at COMMIT.
    await assert.rejects(
      () => admin.query("COMMIT"),
      (error: unknown) => String(error).includes("books_journal_unbalanced"),
    );
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});

test("2 reversal sets reversed_by_entry_id and reverses_entry_id with opposite lines", async (t) => {
  const admin = await connectAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p0-rev");
    const clientId = company.clientId;
    const bank = company.accountIdByCode["1120"];
    const revenue = company.accountIdByCode["4100"];
    assert.ok(bank && revenue);
    const periodId = await tempPeriod(admin, clientId, `rev-${Date.now()}`);
    const created = await createThenPost(clientId, periodId, bank, revenue, {
      entryDate: "2026-09-03",
      memo: `rev-src-${Date.now()}`,
      lines: [
        { accountId: bank, debitMinor: 777 },
        { accountId: revenue, creditMinor: 777 },
      ],
    });
    const rev = await reverseBooksJournal(LAYLA, clientId, created.id, "2026-09-04", "phase0 reverse");
    assert.equal(rev.reversedByEntryId, rev.reversalId);
    assert.equal(rev.reversesEntryId, created.id);

    const links = await admin.query(
      `SELECT status, reversed_by_entry_id, reverses_entry_id FROM books_journal_entries WHERE id = $1`,
      [created.id],
    );
    assert.equal(links.rows[0].status, "reversed");
    assert.equal(String(links.rows[0].reversed_by_entry_id), rev.reversalId);

    const revRow = await admin.query(
      `SELECT status, reverses_entry_id, entry_no FROM books_journal_entries WHERE id = $1`,
      [rev.reversalId],
    );
    assert.equal(revRow.rows[0].status, "posted");
    assert.equal(String(revRow.rows[0].reverses_entry_id), created.id);
    assert.match(String(revRow.rows[0].entry_no), /^(JV|JE)-2026-\d{4}$/);

    const origLines = await admin.query(
      `SELECT account_id::text, debit_minor, credit_minor FROM books_journal_lines
       WHERE entry_id = $1 ORDER BY account_id, debit_minor`,
      [created.id],
    );
    const revLines = await admin.query(
      `SELECT account_id::text, debit_minor, credit_minor FROM books_journal_lines
       WHERE entry_id = $1 ORDER BY account_id, credit_minor`,
      [rev.reversalId],
    );
    assert.equal(origLines.rowCount, revLines.rowCount);
    for (let i = 0; i < origLines.rows.length; i++) {
      const o = origLines.rows[i];
      const r = revLines.rows.find((x) => x.account_id === o.account_id);
      assert.ok(r);
      assert.equal(Number(r.debit_minor), Number(o.credit_minor));
      assert.equal(Number(r.credit_minor), Number(o.debit_minor));
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("3 JV-YYYY-#### gapless per company/year under concurrent posts", async (t) => {
  const admin = await connectAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p0-conc");
    const clientId = company.clientId;
    const bank = company.accountIdByCode["1120"];
    const revenue = company.accountIdByCode["4100"];
    assert.ok(bank && revenue);
    const periodId = await tempPeriod(admin, clientId, `je-conc-${Date.now()}`);
    const n = 8;
    const drafts = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        createBooksJournal(OMAR, clientId, {
          periodId,
          entryDate: "2026-09-05",
          memo: `conc-${Date.now()}-${i}`,
          lines: [
            { accountId: bank, debitMinor: 100 + i },
            { accountId: revenue, creditMinor: 100 + i },
          ],
          post: false,
        }),
      ),
    );
    const results = await Promise.all(drafts.map((d) => postBooksJournal(LAYLA, clientId, d.id)));
    const nos = results.map((r) => r.entryNo).filter(Boolean) as string[];
    assert.equal(nos.length, n);
    for (const no of nos) assert.match(no, /^(JV|JE)-2026-\d{4}$/);
    const unique = new Set(nos);
    assert.equal(unique.size, n, "voucher numbers must be unique under concurrency");
    const seqs = [...nos].map((x) => Number(x.slice(-4))).sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1, "concurrent posts must stay gapless within the batch");
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("4 RLS A≠B via API and daftar_app role (read + write)", async (t) => {
  const admin = await connectAdmin(t);
  if (!admin) return;
  const app = new pg.Client({ connectionString: appUrl() });
  try {
    await app.connect();
    const companyA = await createTestCompany(admin, "p0-rls-a");
    const companyB = await createTestCompany(admin, "p0-rls-b");
    const clientA = companyA.clientId;
    const clientB = companyB.clientId;
    const bankA = companyA.accountIdByCode["1120"];
    const revenueA = companyA.accountIdByCode["4100"];
    assert.ok(bankA && revenueA);

    // Grant A-only user access to company A only (not B).
    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [A_ONLY, clientA],
    );

    // Seed a posted journal so A-only has something to read on A.
    const periodA = await tempPeriod(admin, clientA, `rls-a-${Date.now()}`);
    const seed = await createBooksJournal(OMAR, clientA, {
      periodId: periodA,
      entryDate: "2026-09-10",
      memo: "rls-seed",
      lines: [
        { accountId: bankA, debitMinor: 50 },
        { accountId: revenueA, creditMinor: 50 },
      ],
      post: false,
    });
    await postBooksJournal(LAYLA, clientA, seed.id);

    const own = await listBooksJournals(A_ONLY, clientA);
    assert.ok(own.length > 0, "A-only user can read company A journals");

    // API: A-only cannot resolve / read company B (clients + books RLS)
    await assert.rejects(
      () => listBooksJournals(A_ONLY, clientB),
      (error: unknown) =>
        error instanceof Error &&
        (error.message === "client_not_found" || String(error).includes("client_not_found")),
    );

    const gulfPeriod = companyB.periods["May 2026"] || (await tempPeriod(admin, clientB, `rls-b-${Date.now()}`));
    const gulfBank = companyB.accountIdByCode["1120"];
    const gulfRev = companyB.accountIdByCode["4100"];
    assert.ok(gulfBank && gulfRev);
    await assert.rejects(
      () =>
        createBooksJournal(A_ONLY, clientB, {
          periodId: String(gulfPeriod),
          entryDate: "2026-04-15",
          memo: "rls-write-block",
          lines: [
            { accountId: String(gulfBank), debitMinor: 50 },
            { accountId: String(gulfRev), creditMinor: 50 },
          ],
          post: false,
        }),
      () => true,
    );

    // daftar_app role + set_config: read B as A-only → 0 rows; write rejected
    await app.query("BEGIN");
    await app.query(`SELECT set_config('app.current_user_id', $1, true)`, [A_ONLY]);
    const readB = await app.query(
      `SELECT count(*)::int AS n FROM books_journal_entries WHERE client_id = $1`,
      [clientB],
    );
    assert.equal(readB.rows[0].n, 0);
    const readA = await app.query(
      `SELECT count(*)::int AS n FROM books_journal_entries WHERE client_id = $1`,
      [clientA],
    );
    assert.ok(readA.rows[0].n > 0);
    await assert.rejects(
      () =>
        app.query(
          `INSERT INTO books_journal_entries (
             client_id, period_id, memo, entry_date, status, content_hash, created_by
           ) VALUES ($1,$2,'rls','2026-04-16','draft','h',$3)`,
          [clientB, gulfPeriod, A_ONLY],
        ),
      () => true,
    );
    await app.query("ROLLBACK");
  } finally {
    await app.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});

test("5 audit one assertion per action", async (t) => {
  const admin = await connectAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p0-audit");
    const clientId = company.clientId;
    const bank = company.accountIdByCode["1120"];
    const revenue = company.accountIdByCode["4100"];
    assert.ok(bank && revenue);
    const periodId = await tempPeriod(admin, clientId, `audit-${Date.now()}`);
    const draft = await createBooksJournal(OMAR, clientId, {
      periodId,
      entryDate: "2026-09-06",
      memo: "audit-desc",
      lines: [
        { accountId: bank, debitMinor: 300, tags: [] },
        { accountId: revenue, creditMinor: 300 },
      ],
      post: false,
    });
    await updateBooksJournalTags(OMAR, clientId, draft.id, ["ops", "q3"]);
    const posted = await postBooksJournal(LAYLA, clientId, draft.id);
    assert.ok(posted.entryNo);
    await updateBooksJournalMemo(OMAR, clientId, draft.id, "audit-desc-edited");
    await updateBooksJournalNote(OMAR, clientId, draft.id, "cashier note");
    await updateBooksJournalTags(OMAR, clientId, draft.id, ["ops", "q3", "posted-tag"]);
    await reverseBooksJournal(LAYLA, clientId, draft.id, "2026-09-07", "phase0 reverse");

    const periodAuditId = periodId;
    await lockBooksPeriod(LAYLA, clientId, periodAuditId);
    await reopenBooksPeriod(LAYLA, clientId, periodAuditId, "audit unlock");

    const entryAudit = await listBooksAudit(OMAR, clientId, draft.id);
    const actions = new Set(entryAudit.map((r) => r.action));
    for (const need of ["create", "post", "reverse", "edit_description", "edit_note", "tag"]) {
      assert.ok(actions.has(need), `missing audit action ${need}`);
    }
    const periodEvents = await admin.query(
      `SELECT action FROM books_audit_events WHERE entity_id = $1`,
      [periodAuditId],
    );
    const periodActions = new Set(periodEvents.rows.map((r) => r.action));
    assert.ok(periodActions.has("lock"), "missing lock audit");
    assert.ok(periodActions.has("unlock"), "missing unlock audit");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("6 COA template, hierarchy, postable guard, delete blocked", async (t) => {
  const admin = await connectAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p0-coa");
    const clientId = company.clientId;
    const bankId = company.accountIdByCode["1120"];
    const revenueId = company.accountIdByCode["4100"];
    assert.ok(bankId && revenueId);

    const tree = await booksCoaTree(OMAR, clientId);
    assert.ok(tree.length > 0);
    const flat = await listBooksAccounts(OMAR, clientId);
    const codes = new Set(flat.map((a) => a.code));
    for (const code of ["1000", "1100", "1120", "1210", "2210", "3100", "4100", "6600"]) {
      assert.ok(codes.has(code), `missing COA code ${code}`);
    }
    const cash = flat.find((a) => a.code === PARENT_CASH);
    assert.equal(cash?.isPostable, false);
    const bank = flat.find((a) => a.code === "1120");
    assert.equal(bank?.isPostable, true);
    assert.ok(bank?.parentId);

    const periodId = await tempPeriod(admin, clientId, `coa-${Date.now()}`);
    const parentId = String(cash!.id);
    await assert.rejects(
      () =>
        createBooksJournal(OMAR, clientId, {
          periodId,
          entryDate: "2026-09-08",
          memo: "non-postable",
          lines: [
            { accountId: parentId, debitMinor: 10 },
            { accountId: revenueId, creditMinor: 10 },
          ],
          post: true,
        }),
      (error: unknown) => error instanceof BooksError || String(error).includes("not_postable"),
    );

    // Post once so account has postings — delete must be blocked.
    const draft = await createBooksJournal(OMAR, clientId, {
      periodId,
      entryDate: "2026-09-08",
      memo: "coa-posting",
      lines: [
        { accountId: bankId, debitMinor: 10 },
        { accountId: revenueId, creditMinor: 10 },
      ],
      post: false,
    });
    await postBooksJournal(LAYLA, clientId, draft.id);

    await assert.rejects(
      () => admin.query(`DELETE FROM books_accounts WHERE id = $1`, [bankId]),
      (error: unknown) => String(error).includes("books_account_has_postings"),
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("7 golden B/C fixtures prepared with TODO expected TB", () => {
  const root = path.join(process.cwd(), "fixtures", "books-goldens");
  for (const letter of ["b", "c"]) {
    const input = JSON.parse(
      readFileSync(path.join(root, letter, "opening-balance.input.json"), "utf8"),
    );
    const expected = JSON.parse(readFileSync(path.join(root, letter, "expected", "tb.json"), "utf8"));
    assert.ok(Array.isArray(input.lines) && input.lines.length > 0);
    assert.ok(expected.TODO, `${letter} expected TB must carry owner TODO`);
    assert.deepEqual(expected.accounts, {});
  }
});
