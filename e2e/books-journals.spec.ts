import { expect, test } from "@playwright/test";

const OMAR = "55555555-5555-4555-8555-555555555555";
const DESERT = "e1000001-0000-4000-8000-000000000001";
/** Postable Desert Falcon accounts — COA v2 1120 bank, 4100 revenue (db/17-books-seed.sql) */
const ACCT_1120 = "e3000001-0000-4000-8000-000000000001";
const ACCT_4100 = "e3000001-0000-4000-8000-000000000007";

test("journals create+post, audit tab, and trial balance totals", async ({ page, context }) => {
  const host = (() => {
    try {
      return new URL(process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:43123").hostname;
    } catch {
      return "127.0.0.1";
    }
  })();
  await context.addCookies([
    { name: "daftar_user", value: OMAR, domain: host, path: "/" },
    { name: "daftar_client", value: DESERT, domain: host, path: "/" },
  ]);

  await page.goto("/books/journals");
  await expect(page.getByRole("heading", { name: "Journals" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("books-data-grid")).toBeVisible();

  await expect(page.getByTestId("books-data-grid")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("create-journal-open").click();
  const sheet = page.getByTestId("create-entry-sheet");
  await expect(sheet).toBeVisible({ timeout: 15_000 });

  // P4-3: Accrual template defaults auto-reverse; prepayment warns about asset treatment
  await sheet.getByTestId("create-entry-template-accrual").click();
  await expect(sheet.getByTestId("create-entry-auto-reverse-checkbox")).toBeChecked();
  await expect(sheet.getByTestId("create-entry-template-hint")).toContainText(/auto-reverse/i);
  await sheet.getByTestId("create-entry-template-prepayment").click();
  await expect(sheet.getByTestId("create-entry-template-warning")).toContainText(/1410|asset/i);
  await expect(sheet.getByTestId("create-entry-auto-reverse-checkbox")).not.toBeChecked();
  await sheet.getByTestId("create-entry-template-blank").click();

  await sheet.locator("#ce-desc").fill("E2E manual sale");
  const accounts = sheet.getByTestId("create-entry-account");
  await accounts.nth(0).selectOption(ACCT_1120);
  await accounts.nth(1).selectOption(ACCT_4100);
  await sheet.getByTestId("create-entry-debit").nth(0).fill("10.50");
  await sheet.getByTestId("create-entry-debit").nth(0).blur();
  await sheet.getByTestId("create-entry-credit").nth(1).fill("10.50");
  await sheet.getByTestId("create-entry-credit").nth(1).blur();
  await expect(sheet.getByTestId("create-entry-balance")).toContainText("Balanced");
  await sheet.getByTestId("create-journal").click();

  await expect(page.getByTestId("books-side-drawer")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Audit Log & Linked Entries" }).click();
  await expect(page.getByTestId("journal-audit")).toBeVisible();

  await page.goto("/books/reports/trial-balance");
  await expect(page.getByRole("heading", { name: "Trial balance" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tb-totals")).toContainText("Balanced");
});
