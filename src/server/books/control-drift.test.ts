/**
 * ING-1c: AR/AP control (TB) vs open-item ageing drift.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { controlVsOpenItemsDrift } from "@/server/books/control-drift";
import {
  approveAndPostBooksDocument,
  createBooksDocument,
} from "@/server/books/documents";
import { booksHealthPanel } from "@/server/books/health";
import { createBooksJournal, postBooksJournal } from "@/server/books/journals";
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
  return admin;
}

test("ING-1c: sales invoice → drift 0; bare AR journal → drift + health insight", async (t) => {
  const admin = await withAdmin(t);
  if (!admin) return;
  try {
    const company = await createTestCompany(admin, `ing1c-drift-${Date.now()}`);
    const may = company.periods["May 2026"];
    const ar = company.accountIdByCode["1210"];
    const rev = company.accountIdByCode["4100"];
    assert.ok(may && ar && rev);

    const customer = await createBooksParty(OMAR, company.clientId, {
      partyType: "customer",
      name: `ING1c Cust ${Date.now()}`,
      force: true,
    });
    const inv = await createBooksDocument(OMAR, company.clientId, {
      docType: "sales_invoice",
      partyId: String(customer.id),
      issueDate: "2026-05-10",
      periodId: may,
      documentNumber: `ING1C-${Date.now()}`,
      lines: [{ description: "Service", lineKind: "revenue", vatCode: "ZR", netMinor: 80_00, vatMinor: 0 }],
    });
    await approveAndPostBooksDocument(LAYLA, company.clientId, String(inv.id));

    const balanced = await controlVsOpenItemsDrift(OMAR, company.clientId, may);
    assert.equal(balanced.ar.driftMinor, 0);
    assert.equal(balanced.ar.controlMinor, balanced.ar.openMinor);
    assert.equal(balanced.ap.driftMinor, 0);

    const panelBalanced = await booksHealthPanel(OMAR, company.clientId, may);
    assert.equal(panelBalanced.scorecard.arControlDriftMinor, 0);
    assert.ok(!panelBalanced.insights.some((i) => i.id === "ar_control_vs_open_items"));

    // Extra 1210 posting without an open item → control > open.
    const j = await createBooksJournal(OMAR, company.clientId, {
      periodId: may,
      entryDate: "2026-05-12",
      memo: "ING-1c AR without open item",
      allowControlAccounts: true,
      lines: [
        { accountId: ar, debitMinor: 210_00, aedMinor: 210_00 },
        { accountId: rev, creditMinor: 210_00, aedMinor: 210_00 },
      ],
    });
    await postBooksJournal(LAYLA, company.clientId, j.id);

    const drifted = await controlVsOpenItemsDrift(OMAR, company.clientId, may);
    assert.equal(drifted.ar.driftMinor, 210_00);
    assert.equal(drifted.ar.controlMinor - drifted.ar.openMinor, 210_00);

    const panel = await booksHealthPanel(OMAR, company.clientId, may);
    assert.equal(panel.scorecard.arControlDriftMinor, 210_00);
    assert.equal(panel.scorecard.arControlMinor, drifted.ar.controlMinor);
    assert.equal(panel.scorecard.arOpenMinor, drifted.ar.openMinor);
    const insight = panel.insights.find((i) => i.id === "ar_control_vs_open_items");
    assert.ok(insight);
    assert.equal(insight!.severity, "critical");
    assert.match(insight!.body, /210\.00 AED/);
  } finally {
    await admin.end();
  }
});
