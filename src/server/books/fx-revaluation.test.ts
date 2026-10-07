/**
 * P5-3: FX rates + unrealised revaluation (hand-computed fils).
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { aedFromOriginal, parseFxRateToScaled } from "@/lib/fx";
import { getBooksCloseChecklist } from "@/server/books/close";
import {
  approveAndPostBooksDocument,
  createBooksDocument,
} from "@/server/books/documents";
import {
  buildFxRevaluationLines,
  runBooksFxRevaluation,
  upsertBooksFxRate,
} from "@/server/books/fx-revaluation";
import { createBooksJournal, getBooksJournal, postBooksJournal } from "@/server/books/journals";
import { createBooksParty } from "@/server/books/parties";
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
  const ready = await admin.query(`SELECT to_regclass('books_fx_rates') AS t`);
  if (!ready.rows[0]?.t) {
    t.skip("db/59 fx rates not migrated");
    await admin.end();
    return null;
  }
  return admin;
}

async function postAsApprover(
  clientId: string,
  body: Parameters<typeof createBooksJournal>[2],
) {
  const draft = await createBooksJournal(OMAR, clientId, { ...body, post: false });
  await postBooksJournal(LAYLA, clientId, draft.id);
  return draft.id;
}

test("P5-3: hand-computed aedFromOriginal matches task examples", () => {
  const r36725 = Number(parseFxRateToScaled("3.6725"));
  const r36730 = Number(parseFxRateToScaled("3.6730"));
  const r36700 = Number(parseFxRateToScaled("3.6700"));
  assert.equal(aedFromOriginal(100_000, r36725), 367_250);
  assert.equal(aedFromOriginal(100_000, r36730), 367_300);
  assert.equal(367_300 - 367_250, 50);
  assert.equal(aedFromOriginal(50_000, r36725), 183_625);
  assert.equal(aedFromOriginal(50_000, r36700), 183_500);
  assert.equal(183_625 - 183_500, 125);
});

test("P5-3: buildFxRevaluationLines nets 7310", () => {
  const lines = buildFxRevaluationLines(
    [
      {
        kind: "bank",
        refId: "b",
        label: "1121 Bank",
        accountId: "bank",
        accountCode: "1121",
        currency: "USD",
        originalMinor: 100_000,
        carriedAedMinor: 367_250,
        revaluedAedMinor: 367_300,
        diffAedMinor: 50,
      },
      {
        kind: "ar",
        refId: "a",
        label: "AR",
        accountId: "ar",
        accountCode: "1210",
        currency: "USD",
        originalMinor: 50_000,
        carriedAedMinor: 183_625,
        revaluedAedMinor: 183_500,
        diffAedMinor: -125,
      },
    ],
    "fx",
  );
  assert.equal(lines.find((l) => l.accountId === "bank")?.debitMinor, 50);
  assert.equal(lines.find((l) => l.accountId === "ar")?.creditMinor, 125);
  assert.equal(lines.find((l) => l.accountId === "fx")?.debitMinor, 75);
});

test("P5-3: bank gain + AR loss; missing rate; auto-reverse; gate; dual control", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p5-3-fx");
    const periodId = company.periods["May 2026"];
    const bank = company.accountIdByCode["1121"];
    const equity =
      company.accountIdByCode["3100"] ||
      company.accountIdByCode["3200"] ||
      company.accountIdByCode["3500"];
    assert.ok(periodId && bank && equity);

    await admin.query(`UPDATE books_accounts SET currency = 'USD' WHERE id = $1`, [bank]);

    const rateCarry = Number(parseFxRateToScaled("3.6725"));

    // USD bank 1,000.00 carried at 3.6725 = AED 3,672.50
    await postAsApprover(company.clientId, {
      periodId,
      entryDate: "2026-05-10",
      memo: "USD bank funding",
      lines: [
        {
          accountId: bank,
          debitMinor: 367_250,
          creditMinor: 0,
          currency: "USD",
          originalMinor: 100_000,
          fxRateScaled: rateCarry,
          aedMinor: 367_250,
        },
        { accountId: equity, debitMinor: 0, creditMinor: 367_250 },
      ],
    });

    const customer = await createBooksParty(OMAR, company.clientId, {
      partyType: "customer",
      name: `FX Cust ${Date.now()}`,
      country: "US",
    });
    assert.ok(customer.id);
    // USD AR 500.00 at 3.6725 = AED 1,836.25
    const doc = await createBooksDocument(OMAR, company.clientId, {
      docType: "sales_invoice",
      partyId: String(customer.id),

      issueDate: "2026-05-15",
      periodId,
      documentNumber: `FX-${Date.now()}`,
      currency: "USD",
      fxRateScaled: rateCarry,
      lines: [
        {
          description: "USD AR",
          lineKind: "revenue",
          vatCode: "OS",
          netMinor: 50_000,
          vatMinor: 0,
          originalMinor: 50_000,
          fxRateScaled: rateCarry,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, company.clientId, String(doc.id));

    let gate = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    const fxFail = gate.gates.find((g) => g.key === "fx_revaluation");
    assert.equal(fxFail?.status, "fail");
    assert.ok(fxFail?.detail?.includes("Missing rates") || fxFail?.detail?.includes("Missing FX"));

    await assert.rejects(
      () => runBooksFxRevaluation(OMAR, company.clientId, periodId),
      /fx_rate_missing/,
    );

    // Task: bank rate 3.6730, AR rate 3.6700 — one rate per currency per date, so use two dates?
    // Spec: rate for period-end date. One USD rate at period end applies to all USD items.
    // Task examples use different rates for bank vs AR — that can't be one currency×date.
    // Decision: one period-end USD rate. Split into two scenarios below for exact amounts;
    // combined run uses 3.6730 for both (bank gain 0.50; AR: 183625→183650 = gain 25).
    // Separate focused assertions for each hand-computed case:

    // --- Bank-only path at 3.6730 ---
    await upsertBooksFxRate(OMAR, company.clientId, {
      currency: "USD",
      rateDate: "2026-05-31",
      rate: "3.6730",
    });

    // Close AR temporarily by zeroing open via admin so bank-only reval is clean... 
    // Instead: run with both; verify bank line = +50 and AR revalued at 3.6730.
    const arRevaluedAtBankRate = aedFromOriginal(50_000, Number(parseFxRateToScaled("3.6730")));
    assert.equal(arRevaluedAtBankRate, 183_650);

    const run1 = await runBooksFxRevaluation(OMAR, company.clientId, periodId);
    assert.equal(run1.created, true);
    assert.equal(run1.kind, "journal");
    assert.ok(run1.journalEntryId);

    const je = await getBooksJournal(OMAR, company.clientId, run1.journalEntryId!);
    assert.equal(je.entryType, "fx_revaluation");
    assert.equal(je.autoReverseNextPeriod, true);
    type JLine = { accountCode: string; debitMinor: number; creditMinor: number };
    const lines = je.lines as JLine[];
    const bankLine = lines.find((l) => l.accountCode === "1121");
    const arLine = lines.find((l) => l.accountCode === "1210");
    const fxLine = lines.find((l) => l.accountCode === "7310");
    assert.ok(bankLine && arLine && fxLine);
    assert.equal(bankLine.debitMinor, 50); // gain 0.50
    assert.equal(bankLine.creditMinor, 0);
    // AR at 3.6730: revalued 183650 - carried 183625 = +25 gain → Dr 1210 25
    assert.equal(arLine.debitMinor, 25);
    // Net 7310: bank gain 50 + AR gain 25 = Cr 75
    assert.equal(fxLine.creditMinor, 75);

    // Idempotent replace draft
    const run2 = await runBooksFxRevaluation(OMAR, company.clientId, periodId);
    assert.equal(run2.replaced, true);
    assert.ok(run2.journalEntryId);
    assert.notEqual(run2.journalEntryId, run1.journalEntryId);

    await assert.rejects(
      () => postBooksJournal(OMAR, company.clientId, run2.journalEntryId!),
      /post_requires_approver|post_preparer_cannot_approve/,
    );
    await postBooksJournal(LAYLA, company.clientId, run2.journalEntryId!);

    const job = await admin.query(
      `SELECT payload, run_at FROM books_jobs
       WHERE client_id = $1 AND kind = 'auto_reverse'
       ORDER BY created_at DESC LIMIT 1`,
      [company.clientId],
    );
    assert.ok(job.rowCount);
    const payload = job.rows[0].payload as { reverseOn?: string; entryId?: string };
    assert.equal(payload.reverseOn, "2026-06-01");
    assert.equal(payload.entryId, run2.journalEntryId);

    gate = await getBooksCloseChecklist(OMAR, company.clientId, periodId);
    assert.equal(gate.gates.find((g) => g.key === "fx_revaluation")?.status, "pass");

    await assert.rejects(
      () => runBooksFxRevaluation(OMAR, company.clientId, periodId),
      /fx_revaluation_already_posted/,
    );

    // --- Isolated AR loss at 3.6700 (fresh company) ---
    const company2 = await createTestCompany(admin, "p5-3-ar");
    const p2 = company2.periods["May 2026"];
    assert.ok(p2);
    const cust2 = await createBooksParty(OMAR, company2.clientId, {
      partyType: "customer",
      name: `FX AR ${Date.now()}`,
      country: "US",
    });
    assert.ok(cust2.id);
    const doc2 = await createBooksDocument(OMAR, company2.clientId, {
      docType: "sales_invoice",
      partyId: String(cust2.id),

      issueDate: "2026-05-15",
      periodId: p2,
      documentNumber: `FXAR-${Date.now()}`,
      currency: "USD",
      fxRateScaled: rateCarry,
      lines: [
        {
          description: "USD AR only",
          lineKind: "revenue",
          vatCode: "OS",
          netMinor: 50_000,
          vatMinor: 0,
          originalMinor: 50_000,
          fxRateScaled: rateCarry,
        },
      ],
    });
    await approveAndPostBooksDocument(LAYLA, company2.clientId, String(doc2.id));
    await upsertBooksFxRate(OMAR, company2.clientId, {
      currency: "USD",
      rateDate: "2026-05-31",
      rate: "3.6700",
    });
    const arRun = await runBooksFxRevaluation(OMAR, company2.clientId, p2);
    const arJe = await getBooksJournal(OMAR, company2.clientId, arRun.journalEntryId!);
    const arLines = arJe.lines as JLine[];
    assert.equal(arLines.find((l) => l.accountCode === "1210")?.creditMinor, 125);
    assert.equal(arLines.find((l) => l.accountCode === "7310")?.debitMinor, 125);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
