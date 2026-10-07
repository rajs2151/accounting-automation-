/**
 * QA walkthrough fixes (UI flows): expense paid-from accounts, fixed-asset accounts + cost booking,
 * journal edit-then-post dual control and draft reference. Synthetic data only; every test makes
 * its own company.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import {
  approveAndPostBooksExpense,
  createBooksExpense,
  submitBooksExpense,
  updateBooksExpenseDraft,
} from "@/server/books/expenses";
import { registerBooksFixedAsset, runBooksDepreciation } from "@/server/books/fixed-assets";
import {
  createBooksJournal,
  getBooksJournal,
  postBooksJournal,
  replaceBooksJournalDraft,
} from "@/server/books/journals";
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
  const ready = await admin.query(
    `SELECT to_regclass('books_expenses') AS e, to_regclass('books_fixed_assets') AS f`,
  );
  if (!ready.rows[0]?.e || !ready.rows[0]?.f) {
    t.skip("expenses / fixed-asset migrations not applied");
    await admin.end();
    return null;
  }
  return admin;
}

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(p, (err: Error) => {
    assert.match(err.message, pattern);
    return true;
  });
}

type Company = Awaited<ReturnType<typeof createTestCompany>>;

function expenseBody(c: Company, over: Record<string, unknown> = {}) {
  return {
    expenseDate: "2026-05-14",
    periodId: c.periods["May 2026"]!,
    description: "Taxi",
    vendorName: "Cab co",
    lines: [{ accountId: c.accountIdByCode["6600"]!, netMinor: 12_000, vatMinor: 0 }],
    ...over,
  };
}

test("expense: petty cash credits 1110 Petty cash, never 2130", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "uif-petty");
    // No account sent → the kind's default.
    const e = await createBooksExpense(OMAR, c.clientId, expenseBody(c, { paidFromKind: "petty_cash" }));
    assert.equal(e.paidFromAccountId, c.accountIdByCode["1110"]);

    // The QA bug: kind "Petty cash" with the form's stale 2130 default is refused.
    await rejects(
      createBooksExpense(
        OMAR,
        c.clientId,
        expenseBody(c, { paidFromKind: "petty_cash", paidFromAccountId: c.accountIdByCode["2130"] }),
      ),
      /paid_from_account_mismatch/,
    );

    // Defaults for the other kinds.
    const emp = await createBooksExpense(
      OMAR,
      c.clientId,
      expenseBody(c, { paidFromKind: "employee_reimbursable" }),
    );
    assert.equal(emp.paidFromAccountId, c.accountIdByCode["2130"]);
    const card = await createBooksExpense(OMAR, c.clientId, expenseBody(c, { paidFromKind: "card" }));
    assert.equal(card.paidFromAccountId, c.accountIdByCode["2150"]);
    const bank = await createBooksExpense(OMAR, c.clientId, expenseBody(c, { paidFromKind: "bank" }));
    assert.ok(bank.paidFromAccountId);
    assert.notEqual(bank.paidFromAccountId, c.accountIdByCode["1110"]);

    // Changing the kind on a draft re-defaults its account.
    const switched = await updateBooksExpenseDraft(OMAR, c.clientId, emp.id, { paidFromKind: "petty_cash" });
    assert.equal(switched.paidFromAccountId, c.accountIdByCode["1110"]);

    // Posted journal credits 1110.
    await submitBooksExpense(OMAR, c.clientId, e.id);
    const posted = await approveAndPostBooksExpense(LAYLA, c.clientId, e.id);
    const lines = await admin.query(
      `SELECT a.code, l.credit_minor::bigint AS cr
       FROM books_journal_lines l JOIN books_accounts a ON a.id = l.account_id
       WHERE l.entry_id = $1 AND l.credit_minor > 0`,
      [posted.journalEntryId],
    );
    assert.deepEqual(
      lines.rows.map((r) => [String(r.code), Number(r.cr)]),
      [["1110", 12_000]],
    );
  } finally {
    await admin.end();
  }
});

test("fixed asset: a header or wrong-type account is refused", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "uif-fa-acct");
    const base = { name: "QA Laptop", costMinor: 600_000, inServiceDate: "2026-05-01", lifeMonths: 36 };
    await rejects(
      registerBooksFixedAsset(OMAR, c.clientId, { ...base, assetAccountId: c.accountIdByCode["1600"]! }),
      /asset_account_not_postable/,
    );
    await rejects(
      registerBooksFixedAsset(OMAR, c.clientId, { ...base, assetAccountId: c.accountIdByCode["1120"]! }),
      /asset_account_wrong_type/,
    );
    await rejects(
      registerBooksFixedAsset(OMAR, c.clientId, {
        ...base,
        assetAccountId: c.accountIdByCode["1620"]!,
        accumulatedAccountId: c.accountIdByCode["6800"]!,
      }),
      /asset_account_wrong_type/,
    );
    // Intangible asset picks the amortisation pair by default.
    const sw = await registerBooksFixedAsset(OMAR, c.clientId, {
      ...base,
      name: "ERP licence",
      assetAccountId: c.accountIdByCode["1710"]!,
    });
    assert.equal(sw.assetAccountCode, "1710");
    assert.equal(sw.accumulatedAccountCode, "1790");
    assert.equal(sw.expenseAccountCode, "6810");
  } finally {
    await admin.end();
  }
});

test("fixed asset: acquisition draft books the cost; depreciation waits for it to post", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "uif-fa-acq");
    const may = c.periods["May 2026"]!;
    const asset = await registerBooksFixedAsset(OMAR, c.clientId, {
      name: "QA Laptop",
      costMinor: 360_000,
      inServiceDate: "2026-05-01",
      lifeMonths: 36,
      assetAccountId: c.accountIdByCode["1620"]!,
      acquisitionCreditAccountId: c.accountIdByCode["1120"]!,
    });
    assert.equal(asset.assetAccountCode, "1620");
    assert.equal(asset.accumulatedAccountCode, "1690");
    assert.equal(asset.expenseAccountCode, "6800");
    assert.equal(asset.costStatus, "draft");
    assert.ok(asset.acquisitionJournalEntryId);
    assert.equal(asset.sourceJournalEntryId, asset.acquisitionJournalEntryId);

    const je = await getBooksJournal(OMAR, c.clientId, asset.acquisitionJournalEntryId!);
    assert.equal(je.status, "draft");
    type L = { accountCode: string; debitMinor: number; creditMinor: number };
    const lines = (je.lines as L[]).map((l) => [l.accountCode, l.debitMinor, l.creditMinor]);
    assert.deepEqual(lines.sort(), [
      ["1120", 0, 360_000],
      ["1620", 360_000, 0],
    ]);

    // Cost not on the books yet → depreciation refused with the asset named.
    await rejects(runBooksDepreciation(OMAR, c.clientId, may), /asset_cost_not_posted:QA Laptop/);

    // Dual control on the acquisition draft: the registrar can't post it, an approver can.
    await rejects(postBooksJournal(OMAR, c.clientId, je.id), /post_requires_approver|post_preparer_cannot_approve/);
    await postBooksJournal(LAYLA, c.clientId, je.id);

    const run = await runBooksDepreciation(OMAR, c.clientId, may);
    assert.equal(run.created, true);
    assert.equal(run.totalMinor, 10_000);
    assert.deepEqual(run.uncostedAssets, []);
  } finally {
    await admin.end();
  }
});

test("fixed asset: link to a posted purchase journal; unposted or unrelated links refused", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "uif-fa-link");
    const may = c.periods["May 2026"]!;
    const buy = await createBooksJournal(OMAR, c.clientId, {
      periodId: may,
      entryDate: "2026-05-03",
      memo: "Bought desks",
      lines: [
        { accountId: c.accountIdByCode["1610"]!, debitMinor: 240_000, creditMinor: 0 },
        { accountId: c.accountIdByCode["1120"]!, debitMinor: 0, creditMinor: 240_000 },
      ],
    });
    const base = {
      name: "Desks",
      costMinor: 240_000,
      inServiceDate: "2026-05-03",
      lifeMonths: 24,
      assetAccountId: c.accountIdByCode["1610"]!,
      sourceJournalEntryId: buy.id,
    };
    await rejects(registerBooksFixedAsset(OMAR, c.clientId, base), /asset_source_not_posted/);
    await postBooksJournal(LAYLA, c.clientId, buy.id);
    await rejects(
      registerBooksFixedAsset(OMAR, c.clientId, { ...base, assetAccountId: c.accountIdByCode["1630"]! }),
      /asset_source_wrong_account/,
    );
    await rejects(
      registerBooksFixedAsset(OMAR, c.clientId, {
        ...base,
        acquisitionCreditAccountId: c.accountIdByCode["1120"]!,
      }),
      /asset_cost_source_conflict/,
    );
    await rejects(
      registerBooksFixedAsset(OMAR, c.clientId, {
        ...base,
        sourceJournalEntryId: null,
        acquisitionCreditAccountId: c.accountIdByCode["6600"]!,
      }),
      /acquisition_credit_account_invalid/,
    );
    const linked = await registerBooksFixedAsset(OMAR, c.clientId, base);
    assert.equal(linked.costStatus, "posted");
    assert.equal(linked.acquisitionJournalEntryId, null);
    const run = await runBooksDepreciation(OMAR, c.clientId, may);
    assert.equal(run.totalMinor, 10_000);
  } finally {
    await admin.end();
  }
});

test("journal: an approver who edited a draft can't post it; the draft reference survives", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const c = await createTestCompany(admin, "uif-je-edit");
    const may = c.periods["May 2026"]!;
    const lines = (amt: number) => [
      { accountId: c.accountIdByCode["6600"]!, debitMinor: amt, creditMinor: 0 },
      { accountId: c.accountIdByCode["1120"]!, debitMinor: 0, creditMinor: amt },
    ];
    const draft = await createBooksJournal(OMAR, c.clientId, {
      periodId: may,
      entryDate: "2026-05-10",
      memo: "Omar's draft",
      lines: lines(1_000),
    });
    const before = await getBooksJournal(OMAR, c.clientId, draft.id);
    assert.match(String(before.reference), /^DRAFT-/);

    // The page sends an empty reference when the field was never filled: keep the draft's own.
    await replaceBooksJournalDraft(LAYLA, c.clientId, draft.id, {
      entryDate: "2026-05-10",
      memo: "Layla changed the amount",
      reference: "",
      lines: lines(2_000),
    });
    const after = await getBooksJournal(LAYLA, c.clientId, draft.id);
    assert.equal(after.reference, before.reference);

    // Layla edited it, so she is a preparer now: she can't be the approver.
    await rejects(postBooksJournal(LAYLA, c.clientId, draft.id), /post_preparer_cannot_approve/);
    // Omar created it, so he can't either; the entry stays a draft.
    await rejects(postBooksJournal(OMAR, c.clientId, draft.id), /post_requires_approver|post_preparer_cannot_approve/);
    const still = await getBooksJournal(OMAR, c.clientId, draft.id);
    assert.equal(still.status, "draft");

  } finally {
    await admin.end();
  }
});
