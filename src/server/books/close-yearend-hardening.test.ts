/**
 * Close / year-end hardening regressions:
 * concurrent re-close (1), two-step dual-control year-end (2), back-dating into a locked month (3),
 * gated per-period lock route (4), contra balances at year-end (5), quarterly VAT control gate (6),
 * waivers reset on reopen (7), earlier months locked before year-end (8), reopen requires LOCKED (9),
 * reversals keep foreign-currency amounts — app + worker (10).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import * as close from "@/server/books/close";
import { setCompanyVatSettings } from "@/server/books/company-vat-settings";
import { approveAndPostBooksDocument, createBooksDocument } from "@/server/books/documents";
import {
  createBooksJournal,
  postBooksJournal,
  replaceBooksJournalDraft,
  reverseBooksJournal,
} from "@/server/books/journals";
import { createBooksParty } from "@/server/books/parties";
import { reopenBooksPeriod } from "@/server/books/periods";
import { createTestCompany, type TestCompany } from "@/server/books/test-company";
import * as yearEnd from "@/server/books/year-end";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
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
    `SELECT to_regclass('books_year_end_closes') AS y, to_regclass('books_close_waivers') AS w`,
  );
  if (!ready.rows[0]?.y || !ready.rows[0]?.w) {
    t.skip("db/57 + db/60 not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

async function waiveAllFailing(userId: string, clientId: string, periodId: string) {
  const cl = await close.getBooksCloseChecklist(userId, clientId, periodId);
  for (const key of cl.failing) {
    await close.waiveBooksCloseGate(userId, clientId, periodId, key, "hardening test waiver");
  }
}

async function lockViaGates(company: TestCompany, label: string) {
  const periodId = company.periods[label];
  assert.ok(periodId, label);
  await waiveAllFailing(LAYLA, company.clientId, periodId);
  await close.lockBooksPeriodWithChecklist(LAYLA, company.clientId, periodId);
}

async function postJv(clientId: string, body: Parameters<typeof createBooksJournal>[2]) {
  const d = await createBooksJournal(OMAR, clientId, { ...body, post: false, allowControlAccounts: true });
  await postBooksJournal(LAYLA, clientId, d.id);
  return d.id;
}

/** FY start = July → Jun 2026 is the year-end month of FY2025 (seed calendar Apr–Jun 2026). */
async function yearEndCompany(
  admin: pg.Client,
  label: string,
  opts: { lockEarlier?: boolean; fyStartMonth?: number } = {},
) {
  const company = await createTestCompany(admin, label);
  await admin.query(`UPDATE clients SET fiscal_year_start_month = $2 WHERE id = $1`, [
    company.clientId,
    opts.fyStartMonth ?? 7,
  ]);
  await admin.query(
    `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [RAJ, company.clientId],
  );
  if (opts.lockEarlier !== false) {
    await lockViaGates(company, "Apr 2026");
    await lockViaGates(company, "May 2026");
  }
  return company;
}

/** Revenue 1,000.00 / expense 400.00 in Jun → NI 600.00. */
async function seedJunPnl(company: TestCompany) {
  const bank = company.accountIdByCode["1120"];
  const rev = company.accountIdByCode["4100"];
  const rent = company.accountIdByCode["6200"];
  assert.ok(bank && rev && rent);
  await postJv(company.clientId, {
    periodId: company.periods["Jun 2026"],
    entryDate: "2026-06-10",
    memo: "YE revenue",
    lines: [
      { accountId: bank, debitMinor: 100_000 },
      { accountId: rev, creditMinor: 100_000 },
    ],
  });
  await postJv(company.clientId, {
    periodId: company.periods["Jun 2026"],
    entryDate: "2026-06-12",
    memo: "YE expense",
    lines: [
      { accountId: rent, debitMinor: 40_000 },
      { accountId: bank, creditMinor: 40_000 },
    ],
  });
}

async function postedReBalance(admin: pg.Client, company: TestCompany) {
  const r = await admin.query(
    `SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0)::bigint AS n
     FROM books_journal_lines l
     JOIN books_journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = $1 AND e.client_id = $2 AND e.status IN ('posted', 'reversed')
       AND e.deleted_at IS NULL`,
    [company.accountIdByCode["3200"], company.clientId],
  );
  return Number(r.rows[0].n);
}

test("YE-1: concurrent re-close after reverse serialises — one winner, no orphan draft, RE not doubled", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await yearEndCompany(admin, "ye-h1");
    const jun = company.periods["Jun 2026"];
    await seedJunPnl(company);
    await waiveAllFailing(LAYLA, company.clientId, jun);

    await yearEnd.closeBooksYearToRE(LAYLA, company.clientId, jun);
    await yearEnd.postBooksYearEndClose(RAJ, company.clientId, 2025);
    assert.equal(await postedReBalance(admin, company), 60_000);
    await yearEnd.reverseBooksYearEndClose(RAJ, company.clientId, 2025, "Restate", "2026-06-30");
    assert.equal(await postedReBalance(admin, company), 0);

    const results = await Promise.allSettled([
      yearEnd.closeBooksYearToRE(LAYLA, company.clientId, jun),
      yearEnd.closeBooksYearToRE(RAJ, company.clientId, jun),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    assert.equal(won.length, 1, "exactly one concurrent re-close may win");
    assert.equal(lost.length, 1);
    assert.match(
      String((lost[0] as PromiseRejectedResult).reason),
      /year_end_pending_post|year_end_already_closed/,
    );

    // No orphan closing drafts: only the winner's draft is live.
    const drafts = await admin.query(
      `SELECT id FROM books_journal_entries
       WHERE client_id = $1 AND entry_type = 'closing' AND status = 'draft' AND deleted_at IS NULL`,
      [company.clientId],
    );
    assert.equal(drafts.rowCount, 1);
    const row = await admin.query(
      `SELECT journal_entry_id FROM books_year_end_closes WHERE client_id = $1 AND fiscal_year = 2025`,
      [company.clientId],
    );
    assert.equal(String(row.rows[0].journal_entry_id), String(drafts.rows[0].id));

    // Post by whoever did not prepare; concurrent posts also serialise.
    const winner = (won[0] as PromiseFulfilledResult<{ journalEntryId: string }>).value;
    const prep = await admin.query(`SELECT created_by FROM books_journal_entries WHERE id = $1`, [
      winner.journalEntryId,
    ]);
    const poster = String(prep.rows[0].created_by) === LAYLA ? RAJ : LAYLA;
    const posts = await Promise.allSettled([
      yearEnd.postBooksYearEndClose(poster, company.clientId, 2025),
      yearEnd.postBooksYearEndClose(poster, company.clientId, 2025),
    ]);
    assert.equal(posts.filter((p) => p.status === "fulfilled").length, 1);
    assert.equal(await postedReBalance(admin, company), 60_000, "RE must not double");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("YE-2: year-end is two-step — draft by one approver, posted by a different one", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await yearEndCompany(admin, "ye-h2");
    const jun = company.periods["Jun 2026"];
    await seedJunPnl(company);
    // Lock + reopen Jun so posting must mark the period changed-since-close.
    await waiveAllFailing(LAYLA, company.clientId, jun);
    await close.lockBooksPeriodWithChecklist(LAYLA, company.clientId, jun);
    await close.unlockBooksPeriodWithReason(LAYLA, company.clientId, jun, "YE adjustments");
    await waiveAllFailing(LAYLA, company.clientId, jun);

    await assert.rejects(
      () => yearEnd.closeBooksYearToRE(OMAR, company.clientId, jun),
      /year_end_close_requires_approver/,
    );
    const prepared = await yearEnd.closeBooksYearToRE(LAYLA, company.clientId, jun, "FY2025");
    const je = await admin.query(
      `SELECT status, entry_type, created_by FROM books_journal_entries WHERE id = $1`,
      [prepared.journalEntryId],
    );
    assert.equal(je.rows[0].status, "draft", "step 1 only prepares a draft");
    assert.equal(je.rows[0].entry_type, "closing");
    assert.equal(String(je.rows[0].created_by), LAYLA);
    assert.equal(await postedReBalance(admin, company), 0, "year is not closed until posted");

    const st = await yearEnd.getBooksYearEndStatus(RAJ, company.clientId, jun);
    assert.equal(st.state, "draft");
    assert.equal(st.canPost, true);
    assert.equal((await yearEnd.getBooksYearEndStatus(LAYLA, company.clientId, jun)).canPost, false);

    await assert.rejects(
      () => yearEnd.postBooksYearEndClose(LAYLA, company.clientId, 2025),
      /post_preparer_cannot_approve/,
    );
    await assert.rejects(
      () => yearEnd.postBooksYearEndClose(OMAR, company.clientId, 2025),
      /requires_approver/,
    );
    // Preparing again while a draft is pending is refused.
    await assert.rejects(
      () => yearEnd.closeBooksYearToRE(RAJ, company.clientId, jun),
      /year_end_pending_post/,
    );

    const posted = await yearEnd.postBooksYearEndClose(RAJ, company.clientId, 2025);
    assert.equal(posted.netIncomeMinor, 60_000);
    assert.ok(posted.entryNo);
    const after = await admin.query(
      `SELECT e.status, p.changed_since_close
       FROM books_journal_entries e JOIN books_periods p ON p.id = e.period_id
       WHERE e.id = $1`,
      [prepared.journalEntryId],
    );
    assert.equal(after.rows[0].status, "posted");
    assert.equal(after.rows[0].changed_since_close, true);
    const audit = await admin.query(
      `SELECT actor FROM books_audit_events
       WHERE entity = 'books_journal_entry' AND entity_id = $1 AND action = 'post'`,
      [prepared.journalEntryId],
    );
    assert.equal(String(audit.rows[0].actor), RAJ);
    assert.equal(await postedReBalance(admin, company), 60_000);
    assert.equal((await yearEnd.getBooksYearEndStatus(RAJ, company.clientId, jun)).state, "posted");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("YE-3: entry_date must sit in the period; no back-dating into a LOCKED month", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "ye-h3");
    const may = company.periods["May 2026"];
    const jun = company.periods["Jun 2026"];
    const bank = company.accountIdByCode["1120"];
    const rent = company.accountIdByCode["6200"];
    assert.ok(may && jun && bank && rent);
    const lines = [
      { accountId: rent, debitMinor: 1000 },
      { accountId: bank, creditMinor: 1000 },
    ];
    await lockViaGates(company, "May 2026");

    await assert.rejects(
      () =>
        createBooksJournal(OMAR, company.clientId, {
          periodId: jun,
          entryDate: "2026-05-15",
          memo: "Back-dated",
          lines,
          post: false,
        }),
      /entry_date_outside_period/,
    );
    // Opening cut-over (day before the period) is the only out-of-period date, and it still
    // cannot land in a LOCKED month.
    await assert.rejects(
      () =>
        createBooksJournal(OMAR, company.clientId, {
          periodId: jun,
          entryDate: "2026-05-31",
          memo: "Opening into locked May",
          voucherType: "Opening",
          lines,
          post: false,
        }),
      /period_locked/,
    );

    const draft = await createBooksJournal(OMAR, company.clientId, {
      periodId: jun,
      entryDate: "2026-06-15",
      memo: "Jun draft",
      lines,
      post: false,
    });
    await assert.rejects(
      () =>
        replaceBooksJournalDraft(OMAR, company.clientId, draft.id, {
          entryDate: "2026-05-15",
          lines,
        }),
      /entry_date_outside_period/,
    );
    // A draft whose date drifted outside its period (e.g. legacy data) cannot be posted.
    await admin.query(`UPDATE books_journal_entries SET entry_date = '2026-05-15' WHERE id = $1`, [
      draft.id,
    ]);
    await assert.rejects(
      () => postBooksJournal(LAYLA, company.clientId, draft.id),
      /entry_date_outside_period/,
    );

    // An OPEN period overlapping a LOCKED month cannot be used to slip into it.
    const overlapId = (
      await admin.query(
        `INSERT INTO books_periods (id, client_id, label, period_start, period_end, status)
         VALUES (gen_random_uuid(), $1, 'Q2 adj 2026', '2026-05-01', '2026-06-30', 'OPEN')
         RETURNING id`,
        [company.clientId],
      )
    ).rows[0].id as string;
    await assert.rejects(
      () =>
        createBooksJournal(OMAR, company.clientId, {
          periodId: overlapId,
          entryDate: "2026-05-20",
          memo: "Via overlap",
          lines,
          post: false,
        }),
      /period_locked/,
    );

    // A reversal resolves the period that contains its own date (not the original's period)
    // and refuses a locked one.
    const original = await postJv(company.clientId, {
      periodId: jun,
      entryDate: "2026-06-05",
      memo: "Jun original",
      lines,
    });
    await assert.rejects(
      () => reverseBooksJournal(LAYLA, company.clientId, original, "2026-05-20", "Undo"),
      /period_locked/,
    );
    const jul = (
      await admin.query(
        `INSERT INTO books_periods (id, client_id, label, period_start, period_end, status)
         VALUES (gen_random_uuid(), $1, 'Jul 2026', '2026-07-01', '2026-07-31', 'OPEN')
         ON CONFLICT (client_id, label) DO UPDATE SET status = 'OPEN'
         RETURNING id`,
        [company.clientId],
      )
    ).rows[0].id as string;
    const rev = await reverseBooksJournal(LAYLA, company.clientId, original, "2026-07-02", "Undo");
    const revRow = await admin.query(`SELECT period_id FROM books_journal_entries WHERE id = $1`, [
      rev.reversalId,
    ]);
    assert.equal(String(revRow.rows[0].period_id), jul);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("YE-4: per-period lock / reopen route goes through the close gates and close events", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    // Route wiring: POST periods/:id/lock|reopen must not call the raw period functions.
    const route = readFileSync(
      path.join(process.cwd(), "src/app/api/books/[...path]/route.ts"),
      "utf8",
    );
    assert.doesNotMatch(route, /\blockBooksPeriod\(|\breopenBooksPeriod\(/);
    assert.match(route, /booksPeriodRouteAction\([\s\S]{0,120}"lock"/);
    assert.match(route, /booksPeriodRouteAction\([\s\S]{0,160}"reopen"/);

    const routeAction = (close as Record<string, unknown>).booksPeriodRouteAction as
      | ((u: string, c: string, p: string, a: "lock" | "reopen", r?: string) => Promise<unknown>)
      | undefined;
    assert.equal(typeof routeAction, "function", "close.booksPeriodRouteAction is the route entry");

    const company = await createTestCompany(admin, "ye-h4");
    const may = company.periods["May 2026"];
    const before = await close.getBooksCloseChecklist(LAYLA, company.clientId, may);
    assert.equal(before.ready, false, "fresh company has failing gates");
    await assert.rejects(
      () => routeAction!(LAYLA, company.clientId, may, "lock"),
      (err: unknown) => err instanceof close.CloseGatesFailingError,
    );
    const still = await admin.query(`SELECT status FROM books_periods WHERE id = $1`, [may]);
    assert.equal(still.rows[0].status, "OPEN");

    await waiveAllFailing(LAYLA, company.clientId, may);
    const locked = (await routeAction!(LAYLA, company.clientId, may, "lock")) as {
      id: string;
      status: string;
    };
    assert.equal(locked.status, "LOCKED");
    assert.equal(locked.id, may);
    const reopened = (await routeAction!(LAYLA, company.clientId, may, "reopen", "Fix item")) as {
      status: string;
    };
    assert.equal(reopened.status, "REOPENED");
    const events = await admin.query(
      `SELECT action FROM books_close_events WHERE period_id = $1 ORDER BY at`,
      [may],
    );
    assert.deepEqual(
      events.rows.map((r) => r.action).filter((a) => a !== "WAIVE"),
      ["LOCK", "UNLOCK"],
    );
    const p = await admin.query(`SELECT closed_by FROM books_periods WHERE id = $1`, [may]);
    assert.equal(String(p.rows[0].closed_by), LAYLA);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("YE-5: contra P&L balances (sales returns, debit balance) close on the opposite side", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await yearEndCompany(admin, "ye-h5");
    const jun = company.periods["Jun 2026"];
    await seedJunPnl(company);
    const returns = company.accountIdByCode["4900"];
    const bank = company.accountIdByCode["1120"];
    assert.ok(returns);
    // 4900 Sales returns: income account with a debit balance of 100.00.
    await postJv(company.clientId, {
      periodId: jun,
      entryDate: "2026-06-14",
      memo: "Customer refund",
      lines: [
        { accountId: returns, debitMinor: 10_000 },
        { accountId: bank, creditMinor: 10_000 },
      ],
    });
    await waiveAllFailing(LAYLA, company.clientId, jun);
    const prepared = await yearEnd.closeBooksYearToRE(LAYLA, company.clientId, jun);
    assert.equal(prepared.netIncomeMinor, 50_000);
    const lines = await admin.query(
      `SELECT a.code, l.debit_minor, l.credit_minor
       FROM books_journal_lines l JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1`,
      [prepared.journalEntryId],
    );
    const by = new Map(lines.rows.map((r) => [String(r.code), r]));
    assert.equal(Number(by.get("4900")?.credit_minor), 10_000);
    assert.equal(Number(by.get("4900")?.debit_minor), 0);
    assert.equal(Number(by.get("4100")?.debit_minor), 100_000);
    assert.equal(Number(by.get("6200")?.credit_minor), 40_000);
    assert.equal(Number(by.get("3200")?.credit_minor), 50_000);
    for (const r of lines.rows) {
      assert.ok(Number(r.debit_minor) >= 0 && Number(r.credit_minor) >= 0);
    }
    await yearEnd.postBooksYearEndClose(RAJ, company.clientId, 2025);
    assert.equal(await postedReBalance(admin, company), 50_000);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("YE-6: VAT control gate compares the whole VAT quarter for quarterly filers", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "ye-h6");
    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [RAJ, company.clientId],
    );
    await setCompanyVatSettings(RAJ, company.clientId, {
      establishmentEmirate: "Dubai",
      vatReturnFrequency: "quarterly",
      vatPeriodEndMonth: 6,
    });
    const customer = await createBooksParty(OMAR, company.clientId, {
      partyType: "customer",
      name: `YE6 cust ${Date.now()}`,
      trn: "100000000000081",
      emirate: "Dubai",
      country: "AE",
      force: true,
    });
    // Output VAT in April only — nothing in June.
    const inv = await createBooksDocument(OMAR, company.clientId, {
      docType: "sales_invoice",
      partyId: String(customer.id),
      issueDate: "2026-04-15",
      periodId: company.periods["Apr 2026"],
      documentNumber: `YE6-${Date.now()}`,
      lines: [
        { description: "Bookkeeping", lineKind: "revenue", vatCode: "SR", netMinor: 100_000, vatMinor: 5_000 },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, company.clientId, String(inv.id));

    const cl = await close.getBooksCloseChecklist(LAYLA, company.clientId, company.periods["Jun 2026"]);
    const vat = cl.gates.find((g) => g.key === "vat_control");
    assert.equal(vat?.status, "pass", `vat gate: ${vat?.detail}`);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("YE-7: close-gate waivers are invalidated when the period is reopened", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "ye-h7");
    const may = company.periods["May 2026"];
    const before = await close.getBooksCloseChecklist(LAYLA, company.clientId, may);
    const waivedKeys = [...before.failing];
    assert.ok(waivedKeys.length > 0);
    await waiveAllFailing(LAYLA, company.clientId, may);
    await close.lockBooksPeriodWithChecklist(LAYLA, company.clientId, may);
    await close.unlockBooksPeriodWithReason(LAYLA, company.clientId, may, "Late bill");

    const after = await close.getBooksCloseChecklist(LAYLA, company.clientId, may);
    assert.equal(after.ready, false, "old waivers must not carry over a reopen");
    for (const key of waivedKeys) {
      assert.equal(after.gates.find((g) => g.key === key)?.status, "fail", key);
    }
    await assert.rejects(
      () => close.lockBooksPeriodWithChecklist(LAYLA, company.clientId, may),
      (err: unknown) => err instanceof close.CloseGatesFailingError,
    );
    const ev = await admin.query(
      `SELECT checklist_json FROM books_close_events
       WHERE period_id = $1 AND action = 'UNLOCK'`,
      [may],
    );
    const invalidated = (ev.rows[0].checklist_json?.invalidatedWaivers || []) as Array<{ gate: string }>;
    assert.deepEqual(invalidated.map((w) => w.gate).sort(), waivedKeys.sort());

    // Re-waiving after the reopen counts again.
    await waiveAllFailing(LAYLA, company.clientId, may);
    const relocked = await close.lockBooksPeriodWithChecklist(LAYLA, company.clientId, may);
    assert.equal(relocked.status, "LOCKED");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("YE-8: year-end refuses while earlier months of the fiscal year are not LOCKED", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await yearEndCompany(admin, "ye-h8", { lockEarlier: false });
    const jun = company.periods["Jun 2026"];
    await seedJunPnl(company);
    await waiveAllFailing(LAYLA, company.clientId, jun);
    await assert.rejects(
      () => yearEnd.closeBooksYearToRE(LAYLA, company.clientId, jun),
      /year_has_open_periods:Apr 2026,May 2026/,
    );
    await lockViaGates(company, "Apr 2026");
    await assert.rejects(
      () => yearEnd.closeBooksYearToRE(LAYLA, company.clientId, jun),
      /year_has_open_periods:May 2026$/,
    );
    const drafts = await admin.query(
      `SELECT 1 FROM books_journal_entries
       WHERE client_id = $1 AND entry_type = 'closing' AND deleted_at IS NULL`,
      [company.clientId],
    );
    assert.equal(drafts.rowCount, 0, "refusal leaves no closing draft");
    await lockViaGates(company, "May 2026");
    const ok = await yearEnd.closeBooksYearToRE(LAYLA, company.clientId, jun);
    assert.equal(ok.netIncomeMinor, 60_000);

    // Fiscal year start respected: FY Jun 2025–May 2026 only needs Apr locked, not Jun.
    const other = await yearEndCompany(admin, "ye-h8b", { lockEarlier: false, fyStartMonth: 6 });
    const may = other.periods["May 2026"];
    await postJv(other.clientId, {
      periodId: may,
      entryDate: "2026-05-10",
      memo: "May revenue",
      lines: [
        { accountId: other.accountIdByCode["1120"], debitMinor: 5_000 },
        { accountId: other.accountIdByCode["4100"], creditMinor: 5_000 },
      ],
    });
    await waiveAllFailing(LAYLA, other.clientId, may);
    await assert.rejects(
      () => yearEnd.closeBooksYearToRE(LAYLA, other.clientId, may),
      /year_has_open_periods:Apr 2026$/,
    );
    await lockViaGates(other, "Apr 2026");
    const otherOk = await yearEnd.closeBooksYearToRE(LAYLA, other.clientId, may);
    assert.equal(otherOk.fiscalYear, 2025);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("YE-9: reopen refuses a period that is not LOCKED", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "ye-h9");
    const may = company.periods["May 2026"];
    await assert.rejects(
      () => reopenBooksPeriod(LAYLA, company.clientId, may, "No-op reopen"),
      /period_not_locked/,
    );
    await assert.rejects(
      () => close.unlockBooksPeriodWithReason(LAYLA, company.clientId, may, "No-op reopen"),
      /period_not_locked/,
    );
    const p = await admin.query(`SELECT status FROM books_periods WHERE id = $1`, [may]);
    assert.equal(p.rows[0].status, "OPEN");
    const ev = await admin.query(`SELECT 1 FROM books_close_events WHERE period_id = $1`, [may]);
    assert.equal(ev.rowCount, 0);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

/** USD line: 100.00 USD @ 3.6725 = 367.25 AED, against AED revenue. */
async function postUsdEntry(company: TestCompany, autoReverse: boolean) {
  const usdBank = company.accountIdByCode["1121"];
  const rev = company.accountIdByCode["4100"];
  assert.ok(usdBank && rev);
  const d = await createBooksJournal(OMAR, company.clientId, {
    periodId: company.periods["May 2026"],
    entryDate: "2026-05-20",
    memo: "USD receipt",
    autoReverseNextPeriod: autoReverse,
    lines: [
      {
        accountId: usdBank,
        debitMinor: 36_725,
        currency: "USD",
        originalMinor: 10_000,
        fxRateScaled: 367_250_000,
        aedMinor: 36_725,
      },
      { accountId: rev, creditMinor: 36_725 },
    ],
    post: false,
  });
  await postBooksJournal(LAYLA, company.clientId, d.id);
  return { id: d.id, usdBank };
}

async function usdLine(admin: pg.Client, entryId: string, accountId: string) {
  const r = await admin.query(
    `SELECT debit_minor, credit_minor, currency, original_minor, fx_rate_scaled
     FROM books_journal_lines WHERE entry_id = $1 AND account_id = $2`,
    [entryId, accountId],
  );
  return r.rows[0];
}

test("YE-10: reversals keep original_minor + fx_rate_scaled (app reverse and worker auto_reverse)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "ye-h10");
    await admin.query(`UPDATE books_accounts SET currency = 'USD' WHERE id = $1`, [
      company.accountIdByCode["1121"],
    ]);

    const manual = await postUsdEntry(company, false);
    const rev = await reverseBooksJournal(LAYLA, company.clientId, manual.id, "2026-05-25", "Undo");
    const rl = await usdLine(admin, rev.reversalId, manual.usdBank);
    assert.equal(rl.currency, "USD");
    assert.equal(Number(rl.credit_minor), 36_725);
    assert.equal(Number(rl.debit_minor), 0);
    assert.equal(rl.original_minor == null ? null : Number(rl.original_minor), 10_000);
    assert.equal(rl.fx_rate_scaled == null ? null : Number(rl.fx_rate_scaled), 367_250_000);

    // Worker auto_reverse (Python) on the job enqueued by posting an auto-reverse entry.
    const probe = spawnSync("python3", ["-c", "import psycopg"], { encoding: "utf8" });
    if (probe.status !== 0 || !process.env.WORKER_DATABASE_URL) {
      t.diagnostic("python3/psycopg or WORKER_DATABASE_URL unavailable — worker half skipped");
      return;
    }
    const auto = await postUsdEntry(company, true);
    const job = await admin.query(
      `SELECT id, kind, payload FROM books_jobs
       WHERE client_id = $1 AND kind = 'auto_reverse' AND payload->>'entryId' = $2`,
      [company.clientId, auto.id],
    );
    assert.equal(job.rowCount, 1);
    const script = [
      "import json, os, sys",
      `sys.path.insert(0, ${JSON.stringify(path.join(process.cwd(), "worker/src"))})`,
      "import psycopg",
      "from psycopg.rows import dict_row",
      "from daftar.books_jobs import run_books_job",
      "job = json.loads(sys.argv[1])",
      "conn = psycopg.connect(os.environ['WORKER_DATABASE_URL'], row_factory=dict_row)",
      "run_books_job(conn, job)",
      "conn.close()",
    ].join("\n");
    const run = spawnSync(
      "python3",
      [
        "-c",
        script,
        JSON.stringify({
          id: String(job.rows[0].id),
          kind: "auto_reverse",
          payload: job.rows[0].payload,
        }),
      ],
      { encoding: "utf8", env: process.env },
    );
    assert.equal(run.status, 0, run.stderr);
    const done = await admin.query(`SELECT status, error FROM books_jobs WHERE id = $1`, [
      job.rows[0].id,
    ]);
    assert.equal(done.rows[0].status, "done", String(done.rows[0].error));
    const orig = await admin.query(
      `SELECT status, reversed_by_entry_id FROM books_journal_entries WHERE id = $1`,
      [auto.id],
    );
    assert.equal(orig.rows[0].status, "reversed");
    const wl = await usdLine(admin, String(orig.rows[0].reversed_by_entry_id), auto.usdBank);
    assert.equal(Number(wl.credit_minor), 36_725);
    assert.equal(wl.currency, "USD");
    assert.equal(wl.original_minor == null ? null : Number(wl.original_minor), 10_000);
    assert.equal(wl.fx_rate_scaled == null ? null : Number(wl.fx_rate_scaled), 367_250_000);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
