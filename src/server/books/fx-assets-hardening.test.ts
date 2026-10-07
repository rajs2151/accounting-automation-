/**
 * Phase 5 review fixes — depreciation (atomic runs, deleted drafts, disposal month, catch-up) and FX
 * revaluation (reversed runs count as done, stale gate, closing rate on or before period end, AED-only
 * postings on foreign accounts, AR/AP as of period end). Synthetic data; each test has its own company.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { parseFxRateToScaled } from "@/lib/fx";
import { getBooksCloseChecklist } from "@/server/books/close";
import { approveAndPostBooksDocument, createBooksDocument } from "@/server/books/documents";
import { registerBooksFixedAsset, runBooksDepreciation } from "@/server/books/fixed-assets";
import {
  previewBooksFxRevaluation,
  runBooksFxRevaluation,
  upsertBooksFxRate,
} from "@/server/books/fx-revaluation";
import {
  createBooksJournal,
  postBooksJournal,
  reverseBooksJournal,
  softDeleteBooksJournalDraft,
} from "@/server/books/journals";
import { createBooksParty } from "@/server/books/parties";
import { createReceiptOrPayment } from "@/server/books/settlements";
import { createTestCompany } from "@/server/books/test-company";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";

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
  const ready = await admin.query(`SELECT to_regclass('books_fx_revaluation_runs') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/59 not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

async function gate(clientId: string, periodId: string, key: string) {
  const list = await getBooksCloseChecklist(OMAR, clientId, periodId);
  return list.gates.find((g) => g.key === key);
}

async function deprJournals(admin: pg.Client, clientId: string) {
  const r = await admin.query(
    `SELECT e.id, SUM(l.debit_minor)::bigint AS dr, p.label
     FROM books_journal_entries e
     JOIN books_journal_lines l ON l.entry_id = e.id
     JOIN books_periods p ON p.id = e.period_id
     WHERE e.client_id = $1 AND e.entry_type = 'depreciation' AND e.deleted_at IS NULL
     GROUP BY e.id, p.label`,
    [clientId],
  );
  return r.rows.map((x) => ({ id: String(x.id), dr: Number(x.dr), label: String(x.label) }));
}

const USD_3_6725 = Number(parseFxRateToScaled("3.6725"));

/** USD bank funded with 1,000.00 USD at 3.6725 on 10 May. */
async function fxCompany(admin: pg.Client, label: string) {
  const c = await createTestCompany(admin, label);
  const may = c.periods["May 2026"]!;
  const bank = c.accountIdByCode["1121"]!;
  const equity = (c.accountIdByCode["3100"] || c.accountIdByCode["3200"])!;
  const j = await createBooksJournal(OMAR, c.clientId, {
    periodId: may,
    entryDate: "2026-05-10",
    memo: "Fund USD account",
    post: false,
    lines: [
      { accountId: bank, debitMinor: 367_250, creditMinor: 0, currency: "USD", originalMinor: 100_000, fxRateScaled: USD_3_6725, aedMinor: 367_250 },
      { accountId: equity, debitMinor: 0, creditMinor: 367_250 },
    ],
  });
  await postBooksJournal(LAYLA, c.clientId, j.id);
  return { c, may, bank, equity };
}

test("depreciation: parallel runs leave exactly one journal", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "fa-h-par");
    const may = c.periods["May 2026"]!;
    await registerBooksFixedAsset(OMAR, c.clientId, { name: "Laptop", costMinor: 1_200_000, inServiceDate: "2026-05-01", lifeMonths: 12 });
    await Promise.allSettled([runBooksDepreciation(OMAR, c.clientId, may), runBooksDepreciation(OMAR, c.clientId, may)]);
    const js = await deprJournals(admin, c.clientId);
    assert.equal(js.length, 1);
    assert.equal(js[0]!.dr, 100_000);
  } finally {
    await admin.end();
  }
});

test("depreciation: a deleted draft can be run again; gate waits for the new one", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "fa-h-del");
    const may = c.periods["May 2026"]!;
    await registerBooksFixedAsset(OMAR, c.clientId, { name: "Desk", costMinor: 1_200_000, inServiceDate: "2026-05-01", lifeMonths: 12 });
    const r1 = await runBooksDepreciation(OMAR, c.clientId, may);
    await softDeleteBooksJournalDraft(OMAR, c.clientId, r1.journalEntryId!);
    const r2 = await runBooksDepreciation(OMAR, c.clientId, may);
    assert.equal(r2.created, true);
    assert.notEqual(r2.journalEntryId, r1.journalEntryId);
    await postBooksJournal(LAYLA, c.clientId, r2.journalEntryId!);
    assert.equal((await gate(c.clientId, may, "depreciation"))?.status, "pass");
  } finally {
    await admin.end();
  }
});

test("depreciation: an asset disposed later still depreciates before disposal; missed months catch up", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "fa-h-disp");
    const may = c.periods["May 2026"]!;
    const jun = c.periods["Jun 2026"]!;
    // In service April, disposed September; April was never run → May charges Apr + May.
    await registerBooksFixedAsset(OMAR, c.clientId, {
      name: "Van",
      costMinor: 1_200_000,
      inServiceDate: "2026-04-01",
      lifeMonths: 12,
      disposedAt: "2026-09-15",
    });
    const rMay = await runBooksDepreciation(OMAR, c.clientId, may);
    assert.equal(rMay.created, true);
    assert.equal(rMay.totalMinor, 200_000);
    const rJun = await runBooksDepreciation(OMAR, c.clientId, jun);
    assert.equal(rJun.totalMinor, 100_000);
  } finally {
    await admin.end();
  }
});

test("FX: rate entered before period end counts; reversed revaluation stays done", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const { c, may } = await fxCompany(admin, "fx-h-rev");
    await upsertBooksFxRate(OMAR, c.clientId, { currency: "USD", rateDate: "2026-05-29", rate: "3.6730" });
    const preview = await previewBooksFxRevaluation(OMAR, c.clientId, may);
    assert.deepEqual(preview.missingRates, []);
    assert.equal(preview.totalDiffAedMinor, 50);

    const run = await runBooksFxRevaluation(OMAR, c.clientId, may);
    await postBooksJournal(LAYLA, c.clientId, run.journalEntryId!);
    // What the worker's auto-reverse does on 1 June.
    await reverseBooksJournal(LAYLA, c.clientId, run.journalEntryId!, "2026-06-01", "Auto-reverse FX revaluation");
    assert.equal((await gate(c.clientId, may, "fx_revaluation"))?.status, "pass");
    await assert.rejects(runBooksFxRevaluation(OMAR, c.clientId, may), /fx_revaluation_already_posted/);
    const runs = await admin.query(
      `SELECT kind, journal_entry_id FROM books_fx_revaluation_runs WHERE client_id = $1`,
      [c.clientId],
    );
    assert.equal(runs.rows[0].kind, "journal");
    assert.equal(String(runs.rows[0].journal_entry_id), run.journalEntryId);
  } finally {
    await admin.end();
  }
});

test("FX: a noop run goes stale when new foreign activity changes the difference", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const { c, may, bank, equity } = await fxCompany(admin, "fx-h-stale");
    await upsertBooksFxRate(OMAR, c.clientId, { currency: "USD", rateDate: "2026-05-31", rate: "3.6725" });
    const r1 = await runBooksFxRevaluation(OMAR, c.clientId, may);
    assert.equal(r1.kind, "noop");
    assert.equal((await gate(c.clientId, may, "fx_revaluation"))?.status, "pass");
    const rate = Number(parseFxRateToScaled("3.5000"));
    const j = await createBooksJournal(OMAR, c.clientId, {
      periodId: may,
      entryDate: "2026-05-20",
      memo: "Second USD deposit",
      post: false,
      lines: [
        { accountId: bank, debitMinor: 350_000, creditMinor: 0, currency: "USD", originalMinor: 100_000, fxRateScaled: rate, aedMinor: 350_000 },
        { accountId: equity, debitMinor: 0, creditMinor: 350_000 },
      ],
    });
    await postBooksJournal(LAYLA, c.clientId, j.id);
    assert.equal((await gate(c.clientId, may, "fx_revaluation"))?.status, "fail");
  } finally {
    await admin.end();
  }
});

test("FX: a foreign account with AED-only postings is refused, not written off", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "fx-h-aed");
    const may = c.periods["May 2026"]!;
    const j = await createBooksJournal(OMAR, c.clientId, {
      periodId: may,
      entryDate: "2026-05-10",
      memo: "AED posting to USD account",
      post: false,
      lines: [
        { accountId: c.accountIdByCode["1121"]!, debitMinor: 1_000_000, creditMinor: 0 },
        { accountId: (c.accountIdByCode["3100"] || c.accountIdByCode["3200"])!, debitMinor: 0, creditMinor: 1_000_000 },
      ],
    });
    await postBooksJournal(LAYLA, c.clientId, j.id);
    await upsertBooksFxRate(OMAR, c.clientId, { currency: "USD", rateDate: "2026-05-31", rate: "3.6725" });
    await assert.rejects(runBooksFxRevaluation(OMAR, c.clientId, may), /fx_account_missing_foreign_amounts:1121/);
    const g = await gate(c.clientId, may, "fx_revaluation");
    assert.equal(g?.status, "fail");
    assert.match(String(g?.detail), /1121/);
  } finally {
    await admin.end();
  }
});

test("FX: an invoice paid after period end is still revalued in that period", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "fx-h-asof");
    const may = c.periods["May 2026"]!;
    const jun = c.periods["Jun 2026"]!;
    const party = await createBooksParty(OMAR, c.clientId, { partyType: "customer", name: `FXH Customer ${Date.now()}`, force: true });
    const inv = await createBooksDocument(OMAR, c.clientId, {
      docType: "sales_invoice",
      partyId: String(party.id),
      issueDate: "2026-05-12",
      periodId: may,
      documentNumber: `FXH-${Date.now()}`,
      currency: "USD",
      fxRateScaled: USD_3_6725,
      lines: [{ description: "Export service", lineKind: "revenue", vatCode: "ZR", netMinor: 100_000, vatMinor: 0, originalMinor: 100_000, fxRateScaled: USD_3_6725 }],
    });
    await approveAndPostBooksDocument(LAYLA, c.clientId, String(inv.id));
    const oi = await admin.query(`SELECT id FROM books_open_items WHERE document_id = $1`, [inv.id]);
    await createReceiptOrPayment(OMAR, LAYLA, c.clientId, {
      docType: "receipt",
      partyId: String(party.id),
      issueDate: "2026-06-03",
      periodId: jun,
      bankAccountId: c.accountIdByCode["1121"]!,
      currency: "USD",
      fxRateScaled: USD_3_6725,
      originalAmountMinor: 100_000,
      allocations: [{ openItemId: String(oi.rows[0].id), allocatedOriginalMinor: 100_000 }],
    });
    await upsertBooksFxRate(OMAR, c.clientId, { currency: "USD", rateDate: "2026-05-31", rate: "3.6800" });
    const preview = await previewBooksFxRevaluation(OMAR, c.clientId, may);
    const ar = preview.items.find((i) => i.kind === "ar");
    assert.ok(ar, "invoice open at 31 May is revalued");
    assert.equal(ar!.originalMinor, 100_000);
  } finally {
    await admin.end();
  }
});

test("settlements: a receipt is posted in the period of its own date, not the screen's period", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "stl-h-period");
    const party = await createBooksParty(OMAR, c.clientId, { partyType: "customer", name: `STLH Customer ${Date.now()}`, force: true });
    const res = await createReceiptOrPayment(OMAR, LAYLA, c.clientId, {
      docType: "receipt",
      partyId: String(party.id),
      issueDate: "2026-05-20",
      periodId: c.periods["Jun 2026"]!,
      bankAccountId: c.accountIdByCode["1120"]!,
      originalAmountMinor: 5000,
      remainderKind: "on_account",
      remainderOriginalMinor: 5000,
    });
    const j = await admin.query(
      `SELECT p.label, e.entry_date::text AS d FROM books_journal_entries e
       JOIN books_periods p ON p.id = e.period_id WHERE e.id = $1`,
      [(res as { journalEntryId?: string }).journalEntryId],
    );
    assert.equal(j.rows[0].label, "May 2026");
    assert.equal(j.rows[0].d, "2026-05-20");
  } finally {
    await admin.end();
  }
});
