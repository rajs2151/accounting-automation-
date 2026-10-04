import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OMAR = "55555555-5555-4555-8555-555555555555";
const LAYLA = "44444444-4444-4444-8444-444444444444";
const DESERT = "e1000001-0000-4000-8000-000000000001";
const SUPPLIER = "e9000001-0000-4000-8000-000000000002";
const STMT_BALANCED = "e7000001-0000-4000-8000-000000000098";
const STMT_DROPPED = "e7000001-0000-4000-8000-000000000088";
const PHASE1_DIR = path.join(process.cwd(), "docs", "phase1");

async function savePhase1(name: string, buffer: Buffer) {
  fs.mkdirSync(PHASE1_DIR, { recursive: true });
  const out = path.join(PHASE1_DIR, name);
  fs.writeFileSync(out, buffer);
  console.log(`saved ${out} (${buffer.length} bytes)`);
}

function cookieDomain() {
  const base = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:43123";
  try {
    return new URL(base).hostname;
  } catch {
    return "127.0.0.1";
  }
}

async function setSession(
  context: import("@playwright/test").BrowserContext,
  userId: string,
) {
  const domain = cookieDomain();
  await context.clearCookies();
  await context.addCookies([
    { name: "daftar_user", value: userId, domain, path: "/" },
    { name: "daftar_client", value: DESERT, domain, path: "/" },
  ]);
}

test.beforeEach(async ({ context }) => {
  await setSession(context, OMAR);
});

test("phase1: sales purchases parties inbox visible", async ({ page }) => {
  await page.goto("/books/parties");
  await expect(page.getByRole("heading", { name: "Parties" })).toBeVisible();
  await expect(page.getByText("Oasis Retail LLC")).toBeVisible({ timeout: 15000 });

  await page.goto("/books/sales");
  await expect(page.getByRole("heading", { name: "Sales invoices" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Invoice" }).or(page.getByRole("button", { name: /New|Create/i }))).toBeVisible();

  await page.goto("/books/purchases");
  await expect(page.getByRole("heading", { name: "Purchase bills" })).toBeVisible();
  await expect(page.getByText("Net (AED)")).toBeVisible();
  await expect(page.getByText("(fils)")).toHaveCount(0);

  await page.goto("/books/expenses");
  await expect(page.getByText(/Coming in Phase 3/i)).toBeVisible();

  await page.goto("/books/inbox");
  await expect(page.getByRole("heading", { name: /Inbox/ })).toBeVisible();
});

test("phase1 screenshots: review, statement, purchases, receipts, settings OB", async ({
  page,
}) => {
  await page.goto("/books/inbox/e2e-review-demo");
  await expect(page.getByTestId("review-split-view")).toBeVisible({ timeout: 15000 });
  const previewFile = page.getByTestId("review-file-image").or(page.getByTestId("review-file-pdf"));
  await expect(previewFile).toBeVisible({ timeout: 20000 });
  // Raster must have real dimensions (not a blank 0×0 canvas)
  const natural = await page.getByTestId("review-file-image").evaluate((el) => {
    const img = el as HTMLImageElement;
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  expect(natural.w).toBeGreaterThan(100);
  expect(natural.h).toBeGreaterThan(100);
  await expect(page.getByTestId("bbox-grand_total")).toBeVisible();
  await expect(page.getByTestId("bbox-invoice_no")).toBeVisible();
  await expect(page.getByText("low confidence")).toBeVisible();
  await expect(page.getByText("Grand total", { exact: true })).toBeVisible();
  await expect(page.getByTestId("validation-flags")).toContainText(/balanced/i);
  // Correct INV-SYN-001 amounts must not show FAIL on grand total
  await expect(page.getByTestId("field-grand_total")).not.toHaveClass(/border-red/);
  await savePhase1("review-split-view.png", await page.screenshot({ fullPage: true }));

  const list = await page.request.get("/api/books/statements");
  const rows = (await list.json()) as Array<{ id: string }>;
  expect(Array.isArray(rows), `statements API: ${JSON.stringify(rows)}`).toBeTruthy();
  expect(rows.some((r) => r.id === STMT_BALANCED), "balanced statement seed missing").toBeTruthy();
  expect(rows.some((r) => r.id === STMT_DROPPED), "dropped-row statement seed missing").toBeTruthy();

  await page.goto(`/books/statements/${STMT_BALANCED}`);
  await expect(page.getByTestId("statement-review")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("statement-account")).not.toHaveValue("—");
  await expect(page.getByTestId("statement-iban")).toHaveValue(/AE07/);
  await expect(page.locator('input[value="CLIENT RECEIPT"]')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("statement-balance-status")).toContainText("OK");
  await expect(page.getByTestId("rb-check-0")).toContainText("✓");
  await savePhase1("statement-review.png", await page.screenshot({ fullPage: true }));

  await page.goto(`/books/statements/${STMT_DROPPED}`);
  await expect(page.locator('input[value*="CARD PAYMENT"]')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("rb-check-1")).toContainText("✗");
  await savePhase1("statement-review-dropped.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/purchases");
  await expect(page.getByRole("heading", { name: "Purchase bills" })).toBeVisible();
  await expect(page.getByTestId("purchase-issue-date")).toBeVisible();
  await expect(page.getByTestId("purchase-issue-date")).toHaveValue(/16\/05\/2026|05\/16\/2026/);
  // Must be dd/mm not US mm/dd
  await expect(page.getByTestId("purchase-issue-date")).toHaveValue("16/05/2026");
  await savePhase1("purchases.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/receipts");
  await expect(page.getByRole("heading", { name: /Receipt/i })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Post receipt" })).toBeVisible();
  await expect(page.getByText(/as Layla/i)).toHaveCount(0);
  await savePhase1("receipts.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/settings");
  await expect(page.getByTestId("company-profile")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("company-name")).not.toHaveValue("", { timeout: 15000 });
  await expect(page.getByTestId("periods-table")).toContainText("May 2026");
  await expect(page.getByTestId("opening-balances")).toBeVisible();
  await expect(page.getByTestId("ob-mapping-table")).toBeVisible();
  await expect(page.getByTestId("ob-unlock")).toBeVisible();
  await page.getByTestId("opening-balances").scrollIntoViewIfNeeded();
  await savePhase1("settings-ob.png", await page.screenshot({ fullPage: true }));
  await page.getByTestId("company-profile").scrollIntoViewIfNeeded();
  await savePhase1("settings-profile-periods.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/expenses");
  await expect(page.getByText(/Coming in Phase 3/i)).toBeVisible();
  await savePhase1("expenses-phase3.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/sales");
  await expect(page.getByRole("heading", { name: "Sales invoices" })).toBeVisible();
  await savePhase1("sales.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/inbox");
  await expect(page.getByRole("heading", { name: /Inbox/ })).toBeVisible();
  await savePhase1("inbox.png", await page.screenshot({ fullPage: true }));

  await page.goto("/books/parties");
  await expect(page.getByRole("heading", { name: "Parties" })).toBeVisible();
  await savePhase1("parties.png", await page.screenshot({ fullPage: true }));
});

test("phase1: upload bill → approve → journal visible", async ({ page, context }) => {
  const periods = await page.request.get("/api/books/periods");
  const periodRows = (await periods.json()) as Array<{ id: string; label: string }>;
  const may = periodRows.find((p) => /May 2026/i.test(p.label));
  expect(may?.id, "May 2026 period required").toBeTruthy();

  const docNo = `E2E-PV-${Date.now()}`;
  const create = await page.request.post("/api/books/documents", {
    data: {
      docType: "purchase_bill",
      partyId: SUPPLIER,
      issueDate: "2026-05-12",
      periodId: may!.id,
      documentNumber: docNo,
      lines: [
        {
          description: "E2E office supplies",
          lineKind: "expense",
          vatCode: "SR",
          netMinor: 10000,
          vatMinor: 500,
        },
      ],
    },
  });
  const created = await create.json();
  expect(create.ok(), `create failed: ${JSON.stringify(created)}`).toBeTruthy();
  expect(created.id).toBeTruthy();

  await setSession(context, LAYLA);
  const approve = await page.request.post(`/api/books/documents/${created.id}/approve`, {
    data: {},
  });
  const posted = await approve.json();
  expect(approve.ok(), `approve failed: ${JSON.stringify(posted)}`).toBeTruthy();
  expect(posted.entryNo || posted.journalEntryId).toBeTruthy();
  const entryHint = String(posted.entryNo || "");
  expect(entryHint, "posted entryNo required").toMatch(/^PV-/);

  const journals = await page.request.get(
    `/api/books/journals?periodId=${encodeURIComponent(may!.id)}`,
  );
  const journalRows = (await journals.json()) as Array<{ entryNo?: string; description?: string }>;
  expect(journals.ok(), `journals API: ${JSON.stringify(journalRows)}`).toBeTruthy();
  expect(
    journalRows.some((r) => r.entryNo === entryHint),
    `posted ${entryHint} missing from May journals`,
  ).toBeTruthy();

  await page.goto(`/books/journals?periodId=${encodeURIComponent(may!.id)}`);
  await expect(page.getByTestId("topbar-period")).toBeVisible({ timeout: 20000 });
  await page.getByTestId("topbar-period").selectOption(may!.id);
  await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 20000 });
  const search = page.getByTestId("ledger-toolbar-search");
  if (await search.count()) {
    await search.fill(entryHint);
  }
  await expect(page.getByText(entryHint).first()).toBeVisible({ timeout: 20000 });
});
