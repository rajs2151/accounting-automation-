/**
 * P5-1: close checklist gates, waive, lock, unlock, changed-since-close.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  CloseGatesFailingError,
  getBooksCloseChecklist,
  lockBooksPeriodWithChecklist,
  unlockBooksPeriodWithReason,
  waiveBooksCloseGate,
} from "@/server/books/close";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
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
  const ready = await admin.query(`SELECT to_regclass('books_close_waivers') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/57 close not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

async function waiveAllFailing(
  userId: string,
  clientId: string,
  periodId: string,
  reason = "P5-1 test waiver",
) {
  const cl = await getBooksCloseChecklist(userId, clientId, periodId);
  for (const key of cl.failing) {
    await waiveBooksCloseGate(userId, clientId, periodId, key, reason);
  }
}

test("P5-1: placeholders + dual control; waive then lock", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p5-1-ready");
    const periodId = company.periods["May 2026"];
    assert.ok(periodId);

    const checklist = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    assert.ok(checklist.gates.some((g) => g.key === "depreciation" && g.status === "not_set_up"));
    assert.ok(checklist.gates.some((g) => g.key === "fx_revaluation" && g.status === "not_set_up"));
    assert.ok(checklist.gates.some((g) => g.key === "clearing_info" && g.status === "info"));
    // Fresh synthetic companies have bank COA accounts without statements → fail until waived.
    assert.ok(checklist.failing.includes("statements") || checklist.failing.includes("bank_recon"));

    await assert.rejects(
      () => lockBooksPeriodWithChecklist(OMAR, company.clientId, periodId),
      (err: unknown) =>
        err instanceof CloseGatesFailingError || /lock_requires_approver/.test(String(err)),
    );
    await assert.rejects(
      () => waiveBooksCloseGate(OMAR, company.clientId, periodId, "statements", "no"),
      /lock_requires_approver/,
    );

    await waiveAllFailing(LAYLA, company.clientId, periodId, "Demo close — no live statements");
    const locked = await lockBooksPeriodWithChecklist(LAYLA, company.clientId, periodId);
    assert.equal(locked.status, "LOCKED");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P5-1: suspense fail blocks lock; waive then lock; unlock needs reason; post marks changed", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p5-1-suspense");
    const periodId = company.periods["May 2026"];
    const suspense = company.accountIdByCode["1390"];
    const bank = company.accountIdByCode["1120"];
    assert.ok(periodId && suspense && bank);

    // Post unbalanced-looking but balanced entry that leaves 1390 with a balance:
    // Dr 1390 5000 / Cr 1120 5000
    const draft = await createBooksJournal(OMAR, company.clientId, {
      periodId,
      entryDate: "2026-05-10",
      memo: "Park in suspense",
      lines: [
        { accountId: suspense, debitMinor: 5000 },
        { accountId: bank, creditMinor: 5000 },
      ],
      post: false,
    });
    await postBooksJournal(LAYLA, company.clientId, draft.id);

    const failing = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    const suspenseGate = failing.gates.find((g) => g.key === "suspense");
    assert.equal(suspenseGate?.status, "fail");
    assert.equal(suspenseGate?.balanceMinor, 5000);
    assert.equal(failing.ready, false);

    await assert.rejects(
      () => lockBooksPeriodWithChecklist(LAYLA, company.clientId, periodId),
      (err: unknown) => err instanceof CloseGatesFailingError,
    );

    await assert.rejects(
      () => waiveBooksCloseGate(LAYLA, company.clientId, periodId, "suspense", "  "),
      /waiver_reason_required/,
    );

    await waiveBooksCloseGate(
      LAYLA,
      company.clientId,
      periodId,
      "suspense",
      "Items identified; clearing next month",
    );
    assert.equal(
      (await getBooksCloseChecklist(OMAR, company.clientId, periodId)).gates.find(
        (g) => g.key === "suspense",
      )?.status,
      "waived",
    );
    await waiveAllFailing(LAYLA, company.clientId, periodId, "Waive remaining close gates");
    const afterWaive = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    assert.equal(afterWaive.ready, true);

    await lockBooksPeriodWithChecklist(LAYLA, company.clientId, periodId);

    await assert.rejects(
      () => unlockBooksPeriodWithReason(LAYLA, company.clientId, periodId, ""),
      /reopen_reason_required/,
    );
    await unlockBooksPeriodWithReason(LAYLA, company.clientId, periodId, "Fix suspense item");

    const rent = company.accountIdByCode["6200"];
    assert.ok(rent);
    const afterUnlock = await createBooksJournal(OMAR, company.clientId, {
      periodId,
      entryDate: "2026-05-20",
      memo: "Post after unlock",
      lines: [
        { accountId: rent, debitMinor: 1000 },
        { accountId: bank, creditMinor: 1000 },
      ],
      post: false,
    });
    await postBooksJournal(LAYLA, company.clientId, afterUnlock.id);

    const flag = await admin.query(
      `SELECT changed_since_close, status FROM books_periods WHERE id = $1`,
      [periodId],
    );
    assert.equal(String(flag.rows[0].status), "REOPENED");
    assert.equal(flag.rows[0].changed_since_close, true);

    const cl = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    assert.equal(cl.period.changedSinceClose, true);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("P5-1: scheduled entry in period fails scheduled gate", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p5-1-sched");
    const periodId = company.periods["May 2026"];
    const rent = company.accountIdByCode["6200"];
    const bank = company.accountIdByCode["1120"];
    assert.ok(periodId && rent && bank);

    await createBooksJournal(OMAR, company.clientId, {
      periodId,
      entryDate: "2026-05-31",
      memo: "Scheduled rent",
      scheduledFor: "2026-05-31",
      lines: [
        { accountId: rent, debitMinor: 8000 },
        { accountId: bank, creditMinor: 8000 },
      ],
      post: false,
    });

    const cl = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    const gate = cl.gates.find((g) => g.key === "scheduled");
    assert.equal(gate?.status, "fail");
    assert.ok((gate?.count || 0) >= 1);
    assert.equal(cl.ready, false);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
