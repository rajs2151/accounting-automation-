import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OMAR = "55555555-5555-4555-8555-555555555555";
const DESERT = "e1000001-0000-4000-8000-000000000001";
const PHASE0_DIR = path.join(process.cwd(), "docs", "phase0");

async function savePhase0(name: string, buffer: Buffer) {
  fs.mkdirSync(PHASE0_DIR, { recursive: true });
  fs.writeFileSync(path.join(PHASE0_DIR, name), buffer);
}

async function pickAccount(
  sheet: import("@playwright/test").Locator,
  lineIdx: number,
  code: string,
) {
  const select = sheet.getByTestId("create-entry-account").nth(lineIdx);
  const value = await select.locator("option").evaluateAll((opts, c) => {
    const hit = opts.find((o) => (o.textContent || "").includes(c));
    return hit ? (hit as HTMLOptionElement).value : "";
  }, code);
  expect(value, `account ${code}`).toBeTruthy();
  await select.selectOption(value);
}

function cookieDomain() {
  const base = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:43123";
  try {
    return new URL(base).hostname;
  } catch {
    return "127.0.0.1";
  }
}

test.describe("Phase 0 approval screenshots", () => {
  test.beforeEach(async ({ context }) => {
    const domain = cookieDomain();
    await context.addCookies([
      { name: "daftar_user", value: OMAR, domain, path: "/" },
      { name: "daftar_client", value: DESERT, domain, path: "/" },
    ]);
  });

  test("01 create entry empty", async ({ page }) => {
    await page.goto("/books/journals");
    await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("create-journal-open").click();
    const sheet = page.getByTestId("create-entry-sheet");
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    await savePhase0("create-entry-empty.png", await sheet.screenshot());
  });

  test("02 create entry VAT balanced", async ({ page }) => {
    await page.goto("/books/journals");
    await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("create-journal-open").click();
    const sheet = page.getByTestId("create-entry-sheet");
    await expect(sheet).toBeVisible();
    await sheet.locator("#ce-desc").fill("Screenshot VAT sale");
    await pickAccount(sheet, 0, "1210");
    await sheet.getByTestId("create-entry-debit").nth(0).fill("105.00");
    await sheet.getByTestId("create-entry-debit").nth(0).blur();
    await pickAccount(sheet, 1, "4100");
    await sheet.getByTestId("create-entry-credit").nth(1).fill("100.00");
    await sheet.getByTestId("create-entry-credit").nth(1).blur();
    await sheet.getByTestId("create-entry-vat").nth(1).selectOption("SR");
    await expect(sheet.getByTestId("create-entry-balance")).toContainText(/balanced/i, { timeout: 8_000 });
    await savePhase0("create-entry-vat-balanced.png", await sheet.screenshot());
  });

  test("03 create entry unbalanced", async ({ page }) => {
    await page.goto("/books/journals");
    await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("create-journal-open").click();
    const sheet = page.getByTestId("create-entry-sheet");
    await expect(sheet).toBeVisible();
    await pickAccount(sheet, 0, "1120");
    await sheet.getByTestId("create-entry-debit").nth(0).fill("50.00");
    await sheet.getByTestId("create-entry-debit").nth(0).blur();
    await expect(sheet.getByTestId("create-entry-balance")).toContainText(/out of balance/i, {
      timeout: 5_000,
    });
    await savePhase0("create-entry-unbalanced.png", await sheet.screenshot());
  });

  test("04 filters drawer + chips", async ({ page }) => {
    await page.goto("/books/journals");
    await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("ledger-filters-open").click();
    const drawer = page.getByTestId("ledger-filters-drawer");
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await drawer.locator('input[type="date"]').first().fill("2026-04-01");
    await page.getByRole("button", { name: /^apply$/i }).click();
    await expect(page.getByText(/From 2026-04-01/i)).toBeVisible({ timeout: 8_000 });
    await savePhase0("ledger-filters.png", await page.screenshot({ fullPage: true }));
  });

  test("05 manage tags dialog", async ({ page }) => {
    await page.goto("/books/journals");
    await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /manage tags/i }).click();
    await expect(page.getByRole("heading", { name: /manage tags/i })).toBeVisible({ timeout: 10_000 });
    await savePhase0("manage-tags.png", await page.screenshot({ fullPage: true }));
  });

  test("06 bulk bar", async ({ page }) => {
    await page.goto("/books/journals");
    await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("ledger-select-rows").click();
    const rowCheck = page.getByRole("checkbox", { name: /select row/i }).first();
    await expect(rowCheck).toBeVisible({ timeout: 10_000 });
    await rowCheck.click();
    await expect(page.getByTestId("books-bulk-bar")).toBeVisible({ timeout: 10_000 });
    await savePhase0("ledger-bulk-bar.png", await page.screenshot({ fullPage: true }));
  });

  test("07 COA tree expanded", async ({ page }) => {
    await page.goto("/books/settings");
    await expect(page.getByRole("heading", { name: /chart of accounts/i })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("1120")).toBeVisible();
    await savePhase0("settings-coa.png", await page.screenshot({ fullPage: true }));
  });

  test("08 TB net", async ({ page }) => {
    await page.goto("/books/reports/trial-balance");
    await expect(page.getByRole("heading", { name: /trial balance/i })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("cell", { name: "2210" })).toBeVisible();
    await expect(page.getByTestId("tb-vat-note")).toBeVisible();
    await expect(page.getByTestId("tb-vat-note")).toHaveAttribute("title", /JE-2026-0007|2\.50/);
    await savePhase0("trial-balance-net.png", await page.screenshot({ fullPage: true }));
  });

  test("09 TB movements", async ({ page }) => {
    await page.goto("/books/reports/trial-balance");
    await expect(page.getByRole("heading", { name: /trial balance/i })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel(/show movements/i).check();
    await expect(page.getByText(/opening dr|debits/i).first()).toBeVisible();
    await savePhase0("trial-balance-movements.png", await page.screenshot({ fullPage: true }));
  });

  test("10 home + ledger list", async ({ page }) => {
    await page.goto("/books");
    await savePhase0("home.png", await page.screenshot({ fullPage: true }));
    await page.goto("/books/journals");
    await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
    await savePhase0("journals-datagrid.png", await page.screenshot({ fullPage: true }));
  });

  test("11 ledger full width approval", async ({ page }) => {
    await page.goto("/books/journals");
    await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("columnheader", { name: /^tags$/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /^status$/i })).toBeVisible();
    await savePhase0("ledger-full-width.png", await page.screenshot({ fullPage: true }));
  });
});
