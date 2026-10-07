/**
 * P7-1 e2e: Company Health Dashboard loads summary metrics for the shell period.
 */
import { expect, test, type BrowserContext } from "@playwright/test";

const OMAR = "55555555-5555-4555-8555-555555555555";
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

test("P7-1: Company Health Dashboard shows metric cards", async ({ page, context }) => {
  await setSession(context, OMAR);
  await page.goto("/books/health");
  await expect(page.getByTestId("health-page")).toBeVisible();
  await expect(page.getByTestId("health-tabs")).toBeVisible();
  await expect(page.getByTestId("health-tab-dashboard")).toBeVisible();
  await expect(page.getByTestId("health-metric-cash")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("health-metric-avg-cf")).toBeVisible();
  await expect(page.getByTestId("health-metric-runway")).toBeVisible();
  await expect(page.getByTestId("health-metric-la")).toBeVisible();
  await expect(page.getByTestId("health-error")).toHaveCount(0);
});
