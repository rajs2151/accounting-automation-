/**
 * RPT-1 e2e: TB → group → ledger → entry → source document; ledger footer; Day Book type filter;
 * Ageing 31-60 bucket for a fixture bill; XLSX export carries the on-screen grand total.
 * Data is created by this spec (synthetic); the "uploaded" source is a seeded inbox row, so no worker
 * or object storage is needed.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { inflateRawSync } from "node:zlib";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const DESERT = "e1000001-0000-4000-8000-000000000001";

function cookieDomain() {
  try {
    return new URL(process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${process.env.PORT || 43127}`).hostname;
  } catch {
    return "127.0.0.1";
  }
}

async function setSession(context: BrowserContext, userId: string) {
  const domain = cookieDomain();
  await context.clearCookies();
  await context.addCookies([
    { name: "daftar_user", value: userId, domain, path: "/" },
    { name: "daftar_client", value: DESERT, domain, path: "/" },
  ]);
}

function superClient() {
  return new pg.Client({
    connectionString:
      process.env.DATABASE_URL_SUPER || "postgresql://daftar:daftar-local-only@127.0.0.1:5432/daftar_e2e",
  });
}

/** sheet1.xml text out of an .xlsx (stored by our writer with deflate). */
function sheetXml(buf: Buffer): string {
  let i = 0;
  while (i < buf.length - 30 && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8");
    const start = i + 30 + nameLen + extra;
    const data = buf.subarray(start, start + size);
    if (name === "xl/worksheets/sheet1.xml") {
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    i = start + size;
  }
  throw new Error("sheet1.xml not found");
}

async function mayPeriod(page: Page) {
  const periods = (await (await page.request.get("/api/books/periods")).json()) as Array<{ id: string; label: string }>;
  const may = periods.find((p) => /May 2026/i.test(p.label));
  expect(may?.id, "May 2026 period required").toBeTruthy();
  return may!;
}

test("RPT-1: TB → group → ledger → entry → source document; ledger footer; XLSX total", async ({ page, context }) => {
  await setSession(context, OMAR);
  const may = await mayPeriod(page);
  const stamp = Date.now();

  const partyRes = await page.request.post("/api/books/parties", {
    data: { partyType: "supplier", name: `RPT1 E2E Supplier ${stamp}`, trn: "100000000000091", force: true },
  });
  const party = await partyRes.json();
  expect(partyRes.ok(), JSON.stringify(party)).toBeTruthy();

  // Seed an "uploaded" source (file + confirmed inbox item + extraction) so the drill can open it.
  const admin = superClient();
  await admin.connect();
  const fileId = randomUUID();
  const inboxId = randomUUID();
  const extractionId = randomUUID();
  try {
    await admin.query(
      `INSERT INTO books_files (id, client_id, sha256, storage_key, filename, content_type, byte_size, uploaded_by)
       VALUES ($1,$2,$3,$4,'rpt1-bill.pdf','application/pdf',10,$5)`,
      [fileId, DESERT, `rpt1-e2e-${randomUUID()}`, `books/${DESERT}/${fileId}/rpt1-bill.pdf`, OMAR],
    );
    await admin.query(
      `INSERT INTO books_inbox_items (id, client_id, file_id, detected_type, status) VALUES ($1,$2,$3,'purchase_bill','confirmed')`,
      [inboxId, DESERT, fileId],
    );
    await admin.query(
      `INSERT INTO books_extractions (id, client_id, file_id, inbox_item_id, doc_type, status, fields_json)
       VALUES ($1,$2,$3,$4,'purchase_bill','ready','{}'::jsonb)`,
      [extractionId, DESERT, fileId, inboxId],
    );
  } finally {
    await admin.end();
  }

  const docNo = `RPT1-PV-${stamp}`;
  const create = await page.request.post("/api/books/documents", {
    data: {
      docType: "purchase_bill",
      partyId: party.id,
      issueDate: "2026-05-02",
      dueDate: "2026-05-05",
      periodId: may.id,
      documentNumber: docNo,
      extractionId,
      fileId,
      lines: [{ description: "RPT1 e2e stock", lineKind: "expense", vatCode: "SR", netMinor: 12300, vatMinor: 615 }],
    },
  });
  const created = await create.json();
  expect(create.ok(), JSON.stringify(created)).toBeTruthy();
  await setSession(context, LAYLA);
  const approve = await page.request.post(`/api/books/documents/${created.id}/approve`, { data: {} });
  const posted = await approve.json();
  expect(approve.ok(), JSON.stringify(posted)).toBeTruthy();
  await setSession(context, OMAR);

  // TB (May): expand Liabilities → 2110 ledger.
  await page.goto("/books/reports/trial-balance");
  await page.getByTestId("tb-period").selectOption(may.id);
  await expect(page.getByTestId("tb-totals")).toContainText("Balanced", { timeout: 30_000 });
  await expect(page.getByTestId("report-difference")).toHaveCount(0);
  const grandText = (await page.getByTestId("tb-totals").locator("td").last().textContent())?.trim() || "";
  await page.getByTestId("report-toggle-group:liability").click();
  const apRow = page.locator('[data-testid^="report-row-acct:"]').filter({ hasText: "2110" });
  await expect(apRow).toBeVisible();
  // Phase-0 VAT note on 2210 survives the move onto ReportTable.
  await expect(page.getByTestId("tb-vat-note")).toHaveAttribute("title", /VAT output movements/);

  // XLSX export of this view carries the same grand total.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("report-export-xlsx").click(),
  ]);
  const xml = sheetXml(fs.readFileSync((await download.path())!));
  expect(xml).toContain("Grand total");
  expect(xml).toContain(`<v>${grandText.replace(/,/g, "")}</v>`);

  // Compare preset: previous period (Apr) | this period (May) | Difference.
  await page.getByTestId("tb-view").selectOption("compare");
  const head = page.getByTestId("tb-report").locator("thead");
  await expect(head).toContainText("Apr 2026");
  await expect(head).toContainText("May 2026");
  await expect(head).toContainText("Difference");
  await page.getByTestId("tb-view").selectOption("period");
  await expect(page.getByTestId("tb-totals")).toContainText("Balanced");

  await apRow.click();
  await expect(page).toHaveURL(/account-ledger/);
  await expect(page.getByTestId("report-breadcrumbs")).toContainText("Trial balance");
  await expect(page.getByTestId("ledger-opening")).toBeVisible();
  await expect(page.getByTestId("ledger-closing")).toBeVisible();

  const entryRow = page.locator('[data-testid^="report-row-"]').filter({ hasText: String(posted.entryNo) });
  await expect(entryRow).toBeVisible({ timeout: 30_000 });
  await entryRow.click();
  await expect(page).toHaveURL(/reports\/entry/);
  await expect(page.getByTestId("entry-total")).toBeVisible();
  await expect(page.getByTestId("entry-source")).toContainText(docNo);
  await page.getByTestId("entry-source-link").click();
  await expect(page).toHaveURL(new RegExp(`/books/inbox/${inboxId}`));

  // Ageing (payables) as of 20 Jun: the bill due 5 May is 46 days late → 31-60.
  await page.goto(`/books/reports/ageing?side=ap&asOf=2026-06-20&byParty=0`);
  const ageRow = page.locator('[data-testid^="report-row-"]').filter({ hasText: docNo });
  await expect(ageRow).toBeVisible({ timeout: 30_000 });
  await expect(ageRow).toContainText("46");
  // Columns: Ref | Date | Party | Due | Days | Not due | 0-30 | 31-60 | 61-90 | 90+ | Pending
  await expect(ageRow.locator("td").nth(7)).toHaveText("129.15");
  await expect(ageRow.locator("td").nth(6)).toHaveText("");
});

test("RPT-1: Day Book filter by type", async ({ page, context }) => {
  await setSession(context, OMAR);
  await page.goto("/books/reports/day-book?from=2026-04-01&to=2026-06-30");
  await expect(page.getByTestId("daybook-report")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("daybook-total")).toBeVisible();
  const typeCells = page.locator('[data-testid^="report-row-"] td:nth-child(3)');
  await expect(typeCells.first()).toBeVisible();
  const before = new Set(await typeCells.allTextContents());
  await page.getByTestId("daybook-type").selectOption("Purchase");
  await expect(page).toHaveURL(/type=Purchase/);
  // Wait for the filtered rows, then every row must be a Purchase.
  await expect.poll(async () => [...new Set(await typeCells.allTextContents())].join(","), { timeout: 20_000 }).toBe(
    "Purchase",
  );
  expect(before.size).toBeGreaterThan(1);
  await expect(page.getByTestId("daybook-total")).toContainText("vouchers");
});
