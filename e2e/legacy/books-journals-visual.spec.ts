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

test.describe("Track 1 visual regression", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: "daftar_user", value: OMAR, domain: "127.0.0.1", path: "/" },
      { name: "daftar_client", value: DESERT, domain: "127.0.0.1", path: "/" },
    ]);
  });

  test.afterEach(async ({ page }) => {
    await page.keyboard.press("Escape");
  });

  test("ledger list layout", async ({ page }) => {
    await page.goto("/books/journals");
    await expect(page.getByTestId("ledger-page-chrome")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("books-data-grid")).toBeVisible();
    const shot = await page.screenshot({ fullPage: true });
    await savePhase0("journals-datagrid.png", shot);
    await expect(page).toHaveScreenshot("ledger-list.png", { fullPage: true });
  });

  test("journal drawer", async ({ page }) => {
    await page.goto("/books/journals");
    await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-row-id]").first().click();
    await expect(page.getByTestId("books-side-drawer")).toBeVisible();
    const shot = await page.getByTestId("books-side-drawer").screenshot();
    await savePhase0("journals-sidedrawer.png", shot);
    await expect(page.getByTestId("books-side-drawer")).toHaveScreenshot("journal-drawer.png");
  });

  test("create entry sheet", async ({ page }) => {
    await page.goto("/books/journals");
    await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("create-journal-open").click();
    const sheet = page.getByTestId("create-entry-sheet");
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    const shot = await sheet.screenshot();
    await savePhase0("journals-create-entry.png", shot);
    await expect(sheet).toHaveScreenshot("create-entry-sheet.png");
  });
});
