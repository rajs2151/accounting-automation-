import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { LedgerError } from "./errors";
import { createJournal, createSyntheticDocument, approveExtractionAndPost } from "./ledger";
import {
  approveVat201Pack,
  downloadVat201Pack,
  dualControlRequired,
  hashVat201Payload,
  listDownloadEvents,
  prepareVat201Pack,
  type Vat201Payload,
} from "./release";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const AL_NOOR = "22222222-2222-4222-8222-222222222222";
const PERIOD = "a0000001-0000-4000-8000-000000000001";
const AR = "a1000001-0000-4000-8000-000000000002";
const REVENUE = "a1000001-0000-4000-8000-000000000007";
const VAT_OUT = "a1000001-0000-4000-8000-000000000005";

test("dual control is required during the Stage B window", () => {
  assert.equal(dualControlRequired(new Date("2026-10-15T00:00:00.000Z")), true);
  assert.equal(dualControlRequired(new Date("2027-02-01T00:00:00.000Z")), false);
});

test("VAT201 payload hash is stable for the same canonical inputs", () => {
  const payload: Vat201Payload = {
    kind: "VAT201",
    periodId: PERIOD,
    periodLabel: "Q1 2026",
    periodStart: "2026-01-01",
    periodEnd: "2026-03-31",
    boxes: { "1b": { taxableMinor: 100000, vatMinor: 5000 } },
    totalOutputVat: 5000,
    totalInputVat: 0,
    netPayable: 5000,
    journalEntryIds: ["b", "a"],
    ruleVersion: "vat201-demo-v1",
  };
  const again = { ...payload, journalEntryIds: ["a", "b"] };
  assert.equal(hashVat201Payload(payload), hashVat201Payload(again));
});

test("preparer cannot approve; Layla can release; upstream post marks stale; download logs", async (t) => {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const adminUrl = process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return;
  }
  try {
    const has = await admin.query(`SELECT to_regclass('public.release_packs') AS reg`);
    if (!has.rows[0]?.reg) {
      t.skip("release_packs not migrated");
      return;
    }

    // Ensure Omar has a live draft figure to prepare.
    const sales = await createSyntheticDocument(OMAR, AL_NOOR, {
      periodId: PERIOD,
      docType: "SALES_INVOICE",
      originalName: "release-test-sales.json",
      facts: {
        entryDate: "2026-02-01",
        invoiceNumber: "INV-REL-1",
        counterparty: "Release Test Co",
        taxableMinor: 20000,
        vatMinor: 1000,
      },
    });
    await approveExtractionAndPost(OMAR, AL_NOOR, sales.extractionId);

    const prepared = await prepareVat201Pack(OMAR, AL_NOOR, PERIOD);
    assert.equal(prepared.status, "PENDING_APPROVAL");

    await assert.rejects(
      () => approveVat201Pack(OMAR, AL_NOOR, prepared.id),
      (error: unknown) =>
        error instanceof LedgerError &&
        error.code === "forbidden" &&
        error.message === "preparer_cannot_approve",
    );

    const released = await approveVat201Pack(LAYLA, AL_NOOR, prepared.id);
    assert.equal(released.status, "RELEASED");

    const bundle = await downloadVat201Pack(OMAR, AL_NOOR, prepared.id, { ipHash: "abc", userAgent: "test" });
    assert.equal(bundle.status, "RELEASED");
    assert.ok(bundle.payload);
    const events = await listDownloadEvents(OMAR, AL_NOOR, prepared.id);
    assert.ok(events.length >= 1);

    await createJournal(OMAR, AL_NOOR, {
      periodId: PERIOD,
      memo: "stale-release-test",
      entryDate: "2026-02-05",
      post: true,
      lines: [
        { accountId: AR, debitMinor: 1050 },
        { accountId: REVENUE, creditMinor: 1000 },
        { accountId: VAT_OUT, creditMinor: 50, vat201Box: "1b" },
      ],
    });

    const stale = await admin.query(`SELECT status FROM release_packs WHERE id = $1`, [prepared.id]);
    assert.equal(stale.rows[0].status, "STALE");

    await assert.rejects(
      () => downloadVat201Pack(OMAR, AL_NOOR, prepared.id),
      (error: unknown) =>
        error instanceof LedgerError &&
        error.code === "forbidden" &&
        error.message === "download_requires_released",
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("seed roles: Layla approver can release pack; Omar preparer cannot", async (t) => {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const adminUrl = process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return;
  }
  try {
    const has = await admin.query(`SELECT to_regclass('public.release_packs') AS reg`);
    if (!has.rows[0]?.reg) {
      t.skip("release_packs not migrated");
      return;
    }

    const roles = await admin.query(
      `SELECT id, role, email FROM users WHERE id = ANY($1::uuid[])`,
      [[LAYLA, OMAR]],
    );
    const byId = Object.fromEntries(roles.rows.map((r) => [String(r.id), r]));
    assert.equal(byId[LAYLA]?.role, "approver");
    assert.equal(byId[OMAR]?.role, "accountant");
    assert.equal(byId[LAYLA]?.email, "layla@arnibooks.test");
    assert.equal(byId[OMAR]?.email, "omar@arnibooks.test");

    const sales = await createSyntheticDocument(OMAR, AL_NOOR, {
      periodId: PERIOD,
      docType: "SALES_INVOICE",
      originalName: "verify-s1-dual-control.json",
      facts: {
        entryDate: "2026-02-10",
        invoiceNumber: "INV-VS1-1",
        counterparty: "Verify S1 Co",
        taxableMinor: 10000,
        vatMinor: 500,
      },
    });
    await approveExtractionAndPost(OMAR, AL_NOOR, sales.extractionId);

    const prepared = await prepareVat201Pack(OMAR, AL_NOOR, PERIOD);
    await assert.rejects(
      () => approveVat201Pack(OMAR, AL_NOOR, prepared.id),
      (error: unknown) =>
        error instanceof LedgerError &&
        error.code === "forbidden" &&
        error.message === "preparer_cannot_approve",
    );

    const released = await approveVat201Pack(LAYLA, AL_NOOR, prepared.id);
    assert.equal(released.status, "RELEASED");
    assert.equal(released.approvedBy, LAYLA);

    const approval = await admin.query(
      `SELECT role, actor_id FROM pack_approvals WHERE pack_id = $1 AND role = 'approver'`,
      [prepared.id],
    );
    assert.equal(approval.rowCount, 1);
    assert.equal(String(approval.rows[0].actor_id), LAYLA);
  } finally {
    await admin.end().catch(() => undefined);
  }
});

test("approver least privilege: Layla cannot DELETE/UPDATE pack_approvals or DELETE download_events", async (t) => {
  const appUrl =
    process.env.DATABASE_URL || "postgresql://daftar_app:daftar-local-only@127.0.0.1:5432/daftar_test";
  process.env.DATABASE_URL = appUrl;
  const adminUrl = process.env.DATABASE_URL_SUPER || appUrl.replace("://daftar_app:", "://daftar:");
  const admin = new pg.Client({ connectionString: adminUrl });
  const app = new pg.Client({ connectionString: appUrl });
  try {
    await admin.connect();
  } catch {
    t.skip("Postgres is not reachable");
    return;
  }
  try {
    const has = await admin.query(`SELECT to_regclass('public.release_packs') AS reg`);
    if (!has.rows[0]?.reg) {
      t.skip("release_packs not migrated");
      return;
    }

    const sales = await createSyntheticDocument(OMAR, AL_NOOR, {
      periodId: PERIOD,
      docType: "SALES_INVOICE",
      originalName: "verify-s1-fix1-least-priv.json",
      facts: {
        entryDate: "2026-02-12",
        invoiceNumber: "INV-VS1-LP-1",
        counterparty: "Verify S1 Least Priv Co",
        taxableMinor: 8000,
        vatMinor: 400,
      },
    });
    await approveExtractionAndPost(OMAR, AL_NOOR, sales.extractionId);

    const prepared = await prepareVat201Pack(OMAR, AL_NOOR, PERIOD);
    await assert.rejects(
      () => approveVat201Pack(OMAR, AL_NOOR, prepared.id),
      (error: unknown) =>
        error instanceof LedgerError &&
        error.code === "forbidden" &&
        error.message === "preparer_cannot_approve",
    );

    const released = await approveVat201Pack(LAYLA, AL_NOOR, prepared.id);
    assert.equal(released.status, "RELEASED");

    await downloadVat201Pack(LAYLA, AL_NOOR, prepared.id, { ipHash: "lp", userAgent: "least-priv" });

    const approval = await admin.query(
      `SELECT id, content_hash FROM pack_approvals WHERE pack_id = $1 AND role = 'approver' ORDER BY at DESC LIMIT 1`,
      [prepared.id],
    );
    assert.equal(approval.rowCount, 1);
    const approvalId = String(approval.rows[0].id);
    const originalHash = String(approval.rows[0].content_hash);

    const download = await admin.query(
      `SELECT id FROM download_events WHERE pack_id = $1 ORDER BY at DESC LIMIT 1`,
      [prepared.id],
    );
    assert.equal(download.rowCount, 1);
    const downloadId = String(download.rows[0].id);

    await app.connect();
    await app.query("BEGIN");
    await app.query(`SELECT set_config('app.current_user_id', $1, true)`, [LAYLA]);

    const delApproval = await app.query(`DELETE FROM pack_approvals WHERE id = $1`, [approvalId]);
    assert.equal(delApproval.rowCount, 0, "approver must not DELETE pack_approvals");

    const updApproval = await app.query(
      `UPDATE pack_approvals SET content_hash = $2 WHERE id = $1`,
      [approvalId, "tampered-by-approver"],
    );
    assert.equal(updApproval.rowCount, 0, "approver must not UPDATE pack_approvals");

    const delDownload = await app.query(`DELETE FROM download_events WHERE id = $1`, [downloadId]);
    assert.equal(delDownload.rowCount, 0, "approver must not DELETE download_events");

    await app.query("ROLLBACK");

    const stillApproval = await admin.query(
      `SELECT content_hash FROM pack_approvals WHERE id = $1`,
      [approvalId],
    );
    assert.equal(stillApproval.rowCount, 1);
    assert.equal(String(stillApproval.rows[0].content_hash), originalHash);

    const stillDownload = await admin.query(`SELECT id FROM download_events WHERE id = $1`, [downloadId]);
    assert.equal(stillDownload.rowCount, 1);
  } finally {
    await app.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
