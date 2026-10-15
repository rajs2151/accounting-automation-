/**
 * Phase 2 screenshot review (items 8–12): VAT gates, VAT settlement warn, dual control + posted_by,
 * posted immutability + audit, SBR/QFZP CT banner.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { setCompanyCtSettings } from "@/server/books/company-ct-settings";
import { setCompanyVatSettings } from "@/server/books/company-vat-settings";
import { buildCtBanner } from "@/server/books/ct-estimate";
import { getBooksMonthChecklist } from "@/server/books/dashboard";
import { BooksError } from "@/server/books/errors";
import {
  createBooksJournal,
  getBooksJournal,
  postBooksJournal,
  reverseBooksJournal,
} from "@/server/books/journals";
import { createTestCompany } from "@/server/books/test-company";
import { generateVat201Draft } from "@/server/books/vat201";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const RAJ = "77777777-7777-4777-8777-777777777777";

async function withAdmin(t: test.TestContext) {
  const url =
    process.env.DATABASE_URL_SUPER ||
    process.env.DATABASE_URL ||
    "postgresql://daftar:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  const admin = new pg.Client({ connectionString: url });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return null;
  }
  const ready = await admin.query(
    `SELECT to_regclass('public.books_journal_entries') IS NOT NULL AS ok,
            EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = 'clients' AND column_name = 'sbr_elected'
            ) AS compliance`,
  );
  if (!ready.rows[0]?.ok) {
    t.skip("books tables missing");
    await admin.end().catch(() => undefined);
    return null;
  }
  if (!ready.rows[0]?.compliance) {
    t.skip("db/64 compliance settings not migrated");
    await admin.end().catch(() => undefined);
    return null;
  }
  return admin;
}

test("item 8: VAT draft blocked without establishment emirate even when frequency set", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2-vat-gate");
    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [RAJ, company.clientId],
    );
    await setCompanyVatSettings(RAJ, company.clientId, {
      vatReturnFrequency: "monthly",
      establishmentEmirate: null,
    });
    await assert.rejects(
      generateVat201Draft(OMAR, company.clientId, { monthEnd: "2026-05-31" }),
      (e: unknown) => e instanceof BooksError && e.message === "vat_establishment_emirate_required",
    );
    await setCompanyVatSettings(RAJ, company.clientId, { establishmentEmirate: "Dubai" });
    const draft = await generateVat201Draft(OMAR, company.clientId, { monthEnd: "2026-05-31" });
    assert.equal(draft.from.slice(0, 7), "2026-05");
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("item 8: dashboard VAT due dates require emirate + frequency", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2-dash-vat");
    const periodId = company.periods["May 2026"];
    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [RAJ, company.clientId],
    );
    await setCompanyVatSettings(RAJ, company.clientId, {
      vatReturnFrequency: "monthly",
      establishmentEmirate: null,
    });
    const without = await getBooksMonthChecklist(OMAR, company.clientId, { periodId });
    assert.equal(without.periodStatus.vat.set, false);

    await setCompanyVatSettings(RAJ, company.clientId, { establishmentEmirate: "Dubai" });
    const withBoth = await getBooksMonthChecklist(OMAR, company.clientId, { periodId });
    assert.equal(withBoth.periodStatus.vat.set, true);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("item 9: manual pure VAT settlement returns warning (seed JV-2026-0009 is seed data)", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2-vat-warn");
    const periodId = company.periods["May 2026"];
    const created = await createBooksJournal(OMAR, company.clientId, {
      periodId,
      entryDate: "2026-05-28",
      memo: "Manual VAT clear",
      lines: [
        { accountId: company.accountIdByCode["2210"], debitMinor: 1000 },
        { accountId: company.accountIdByCode["2220"], creditMinor: 1000 },
      ],
    });
    assert.ok(created.warnings?.includes("manual_vat_control_journal"));
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("item 10: post sets posted_by; preparer cannot self-post under dual control", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2-dual");
    const periodId = company.periods["May 2026"];
    const draft = await createBooksJournal(OMAR, company.clientId, {
      periodId,
      entryDate: "2026-05-12",
      memo: "dual control",
      lines: [
        { accountId: company.accountIdByCode["6900"], debitMinor: 500 },
        { accountId: company.accountIdByCode["1120"], creditMinor: 500 },
      ],
    });
    // Accountant preparer cannot post (role); dual-control also blocks same-person approve.
    await assert.rejects(
      postBooksJournal(OMAR, company.clientId, draft.id),
      (e: unknown) =>
        e instanceof BooksError &&
        (e.message === "post_requires_approver" || e.message === "post_preparer_cannot_approve"),
    );
    const posted = await postBooksJournal(LAYLA, company.clientId, draft.id);
    assert.equal(posted.status, "posted");
    const detail = await getBooksJournal(OMAR, company.clientId, draft.id);
    assert.equal(detail.postedBy, LAYLA);
    assert.ok(detail.postedByName);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("item 11: posted lines immutable; correction via reverse; audit has post", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2-immut");
    const periodId = company.periods["May 2026"];
    const draft = await createBooksJournal(OMAR, company.clientId, {
      periodId,
      entryDate: "2026-05-15",
      memo: "immutable",
      lines: [
        { accountId: company.accountIdByCode["6900"], debitMinor: 700 },
        { accountId: company.accountIdByCode["1120"], creditMinor: 700 },
      ],
    });
    await postBooksJournal(LAYLA, company.clientId, draft.id);
    await assert.rejects(
      admin.query(
        `UPDATE books_journal_lines SET debit_minor = 1 WHERE entry_id = $1 AND debit_minor > 0`,
        [draft.id],
      ),
      /books_posted_immutable/,
    );
    const rev = await reverseBooksJournal(LAYLA, company.clientId, draft.id, "2026-05-16", "fix");
    assert.ok(rev.reversalId);
    const audit = await admin.query(
      `SELECT action FROM books_audit_events
       WHERE entity_id = $1::uuid AND action IN ('post', 'reverse')
       ORDER BY at`,
      [draft.id],
    );
    assert.ok(audit.rows.some((r) => r.action === "post"));
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("item 12: CT banner noTaxDue only when SBR elected or QFZP recorded", () => {
  const eligible = buildCtBanner({
    fiscalYear: 2026,
    fiscalYearStart: "2026-01-01",
    fiscalYearEnd: "2026-12-31",
    taxableIncomeMinor: 50_000_000,
    revenueMinor: 50_000_000,
  });
  assert.equal(eligible.smallBusinessReliefMayApply, true);
  assert.equal(eligible.noTaxDueRecorded, false);
  assert.equal(eligible.estimateMinor, 1_125_000);

  const elected = buildCtBanner({
    fiscalYear: 2026,
    fiscalYearStart: "2026-01-01",
    fiscalYearEnd: "2026-12-31",
    taxableIncomeMinor: 50_000_000,
    revenueMinor: 50_000_000,
    sbrElected: true,
  });
  assert.equal(elected.noTaxDueRecorded, true);
  assert.equal(elected.estimateMinor, 0);

  const qfzp = buildCtBanner({
    fiscalYear: 2026,
    fiscalYearStart: "2026-01-01",
    fiscalYearEnd: "2026-12-31",
    taxableIncomeMinor: 50_000_000,
    revenueMinor: 400_000_000,
    isQfzp: true,
  });
  assert.equal(qfzp.smallBusinessReliefMayApply, false);
  assert.equal(qfzp.noTaxDueRecorded, true);
  assert.equal(qfzp.estimateMinor, 0);
});

test("item 12: setCompanyCtSettings persists SBR/QFZP", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, "p2-ct-set");
    await admin.query(
      `INSERT INTO user_client_access (user_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [RAJ, company.clientId],
    );
    const saved = await setCompanyCtSettings(RAJ, company.clientId, {
      sbrElected: true,
      isQfzp: false,
      requireDualControl: true,
    });
    assert.equal(saved.sbrElected, true);
    assert.equal(saved.isQfzp, false);
    assert.equal(saved.requireDualControl, true);
  } finally {
    await admin.end().catch(() => undefined);
  }
});
