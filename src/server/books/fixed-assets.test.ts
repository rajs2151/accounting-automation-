/**
 * P5-2: straight-line depreciation amounts, idempotent run, lock, dual-control, close gate.
 * Expected fils computed by hand in this file — not from production helpers under test for totals.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { getBooksCloseChecklist } from "@/server/books/close";
import {
  amountForDepreciationMonth,
  monthlyStraightLineAmounts,
  registerBooksFixedAsset,
  runBooksDepreciation,
} from "@/server/books/fixed-assets";
import { createBooksJournal, getBooksJournal, postBooksJournal } from "@/server/books/journals";
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
  const ready = await admin.query(`SELECT to_regclass('books_fixed_assets') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/58 fixed assets not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

test("P5-2: hand-computed straight-line schedule (floor + last absorbs)", () => {
  // 36,000.00 / 36 months → 1,000.00 each
  const even = monthlyStraightLineAmounts(3_600_000, 0, 36);
  assert.equal(even.length, 36);
  assert.ok(even.every((a) => a === 100_000));
  assert.equal(even.reduce((s, a) => s + a, 0), 3_600_000);

  // 10,000.00 residual 1,000.00 life 7 → depreciable 9,000.00
  // floor(900_000/7) = 128_571; ×6 = 771_426; last = 128_574; total 900_000
  const uneven = monthlyStraightLineAmounts(1_000_000, 100_000, 7);
  assert.deepEqual(
    uneven.slice(0, 6),
    [128_571, 128_571, 128_571, 128_571, 128_571, 128_571],
  );
  assert.equal(uneven[6], 128_574);
  assert.equal(uneven.reduce((s, a) => s + a, 0), 900_000);
  assert.equal(amountForDepreciationMonth(1_000_000, 100_000, 7, 0), 128_571);
  assert.equal(amountForDepreciationMonth(1_000_000, 100_000, 7, 6), 128_574);
  assert.equal(amountForDepreciationMonth(1_000_000, 100_000, 7, 7), null);
});

test("P5-2: run twice → one journal; preparer cannot post; lock refused; gate", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p5-2-depr");
    const periodId = company.periods["May 2026"];
    const lockedPeriodId = company.periods["Jun 2026"];
    assert.ok(periodId && lockedPeriodId);

    await admin.query(`UPDATE books_periods SET status = 'LOCKED' WHERE id = $1`, [lockedPeriodId]);

    const beforeGate = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    const deprBefore = beforeGate.gates.find((g) => g.key === "depreciation");
    assert.ok(deprBefore);
    assert.equal(deprBefore.status, "pass"); // no assets yet

    const asset = await registerBooksFixedAsset(OMAR, company.clientId, {
      name: "Office fit-out",
      costMinor: 3_600_000,
      residualMinor: 0,
      inServiceDate: "2026-05-10",
      lifeMonths: 36,
    });
    assert.equal(asset.costMinor, 3_600_000);
    assert.equal(asset.schedulePreview[0]?.amountMinor, 100_000);
    assert.equal(asset.assetAccountCode, "1600");
    assert.equal(asset.accumulatedAccountCode, "1690");
    assert.equal(asset.expenseAccountCode, "6800");

    const failGate = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    const deprFail = failGate.gates.find((g) => g.key === "depreciation");
    assert.equal(deprFail?.status, "fail");
    assert.ok(deprFail?.detail?.includes("Office fit-out"));

    await assert.rejects(
      () => runBooksDepreciation(OMAR, company.clientId, lockedPeriodId),
      (err: unknown) =>
        err instanceof Error && /period_locked/.test(err.message),
    );

    const first = await runBooksDepreciation(OMAR, company.clientId, periodId);
    assert.equal(first.created, true);
    assert.ok(first.journalEntryId);
    assert.equal(first.totalMinor, 100_000);
    assert.equal(first.status, "draft");

    const second = await runBooksDepreciation(OMAR, company.clientId, periodId);
    assert.equal(second.created, false);
    assert.equal(second.journalEntryId, first.journalEntryId);

    const runCount = await admin.query(
      `SELECT count(*)::int AS n FROM books_depreciation_runs
       WHERE client_id = $1 AND period_id = $2`,
      [company.clientId, periodId],
    );
    assert.equal(runCount.rows[0].n, 1);

    const jeCount = await admin.query(
      `SELECT count(*)::int AS n FROM books_journal_entries
       WHERE client_id = $1 AND entry_type = 'depreciation' AND deleted_at IS NULL`,
      [company.clientId],
    );
    assert.equal(jeCount.rows[0].n, 1);

    const journal = await getBooksJournal(OMAR, company.clientId, first.journalEntryId!);
    assert.equal(journal.entryType, "depreciation");
    assert.equal(journal.status, "draft");
    type JLine = { accountCode: string; debitMinor: number; creditMinor: number };
    const lines = journal.lines as JLine[];
    const exp = lines.find((l) => l.accountCode === "6800");
    const accum = lines.find((l) => l.accountCode === "1690");
    assert.ok(exp && accum);
    assert.equal(exp.debitMinor, 100_000);
    assert.equal(exp.creditMinor, 0);
    assert.equal(accum.debitMinor, 0);
    assert.equal(accum.creditMinor, 100_000);
    assert.equal(
      lines.reduce((s, l) => s + l.debitMinor, 0),
      lines.reduce((s, l) => s + l.creditMinor, 0),
    );

    // Omar is preparer + accountant → post_requires_approver (dual control).
    await assert.rejects(
      () => postBooksJournal(OMAR, company.clientId, first.journalEntryId!),
      /post_requires_approver|post_preparer_cannot_approve/,
    );

    const posted = await postBooksJournal(LAYLA, company.clientId, first.journalEntryId!);
    assert.equal(posted.status, "posted");

    const passGate = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    const deprPass = passGate.gates.find((g) => g.key === "depreciation");
    assert.equal(deprPass?.status, "pass");

    // Second asset with remainder rule — June is month index 1 for May in-service → still 128_571
    const uneven = await registerBooksFixedAsset(OMAR, company.clientId, {
      name: "Laptop pool",
      costMinor: 1_000_000,
      residualMinor: 100_000,
      inServiceDate: "2026-05-01",
      lifeMonths: 7,
    });
    assert.equal(uneven.schedulePreview[6]?.amountMinor, 128_574);
    assert.equal(
      uneven.schedulePreview.reduce((s, l) => s + l.amountMinor, 0),
      900_000,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P5-2: disposed asset skipped; negative residual rejected", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p5-2-skip");
    const periodId = company.periods["May 2026"];
    assert.ok(periodId);

    await assert.rejects(
      () =>
        registerBooksFixedAsset(OMAR, company.clientId, {
          name: "Bad",
          costMinor: 100_000,
          residualMinor: 100_000,
          inServiceDate: "2026-05-01",
          lifeMonths: 12,
        }),
      /bad_asset_cost/,
    );

    await registerBooksFixedAsset(OMAR, company.clientId, {
      name: "Disposed desk",
      costMinor: 500_000,
      residualMinor: 0,
      inServiceDate: "2026-05-01",
      lifeMonths: 10,
      disposedAt: "2026-04-30",
    });

    const run = await runBooksDepreciation(OMAR, company.clientId, periodId);
    assert.equal(run.created, false);
    assert.equal(run.journalEntryId, null);

    const gate = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    assert.equal(gate.gates.find((g) => g.key === "depreciation")?.status, "pass");

    // Sanity: createBooksJournal still works for unrelated JV on this company
    const bank = company.accountIdByCode["1120"];
    const cash = company.accountIdByCode["1110"];
    assert.ok(bank && cash);
    await createBooksJournal(OMAR, company.clientId, {
      periodId,
      entryDate: "2026-05-15",
      memo: "noise",
      lines: [
        { accountId: bank, debitMinor: 100, creditMinor: 0 },
        { accountId: cash, debitMinor: 0, creditMinor: 100 },
      ],
    });
  } finally {
    await admin.end().catch(() => undefined);
  }
});
