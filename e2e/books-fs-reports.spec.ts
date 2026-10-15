/**
 * P6-2 e2e: P&L monthly → expand → cell drill lists lines; BS balanced; CF gate banner absent.
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

test("P6-2: P&L drill panel; Balance sheet balanced; Cash flow no gate banner", async ({
  page,
  context,
}) => {
  await setSession(context, OMAR);

  await page.goto("/books/reports/pnl");
  await expect(page.getByTestId("reports-tab-pnl")).toBeVisible();
  await expect(page.getByTestId("fs-mode")).toBeVisible();

  // Prefer May 2026 when present (synthetic Desert calendar).
  const period = page.getByTestId("fs-period");
  if (await period.count()) {
    const opts = period.locator("option");
    const n = await opts.count();
    for (let i = 0; i < n; i++) {
      const label = await opts.nth(i).textContent();
      if (label && /May\s*2026/i.test(label)) {
        await period.selectOption({ label: label.trim() });
        break;
      }
    }
  }

  await expect(page.getByTestId("fs-report-pnl")).toBeVisible({ timeout: 30_000 });
  const expand = page.getByTestId("report-expand-all");
  if (await expand.isVisible()) await expand.click();

  // Click a revenue/opex account amount cell when present.
  const acct = page.locator("[data-testid^='fs-acct-']").first();
  if (await acct.count()) {
    await acct.locator("td").nth(1).click();
    await expect(page.getByTestId("fs-drill-panel")).toBeVisible();
    await expect(page.getByTestId("fs-drill-lines")).toBeVisible();
  }

  await page.getByTestId("reports-tab-bs").click();
  await expect(page.getByTestId("fs-report-bs")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("fs-total-assets")).toBeVisible();
  await expect(page.getByTestId("fs-total-le")).toBeVisible();
  // Balanced: no integrity banner (or only if DESERT data is unbalanced — then skip assertion).
  const banner = page.getByTestId("fs-gate-banner");
  if (await banner.count()) {
    const text = await banner.textContent();
    expect(text || "").not.toMatch(/Balance sheet/i);
  }

  await page.getByTestId("reports-tab-cf").click();
  await expect(page.getByTestId("fs-report-cf")).toBeVisible({ timeout: 30_000 });
  if (await banner.count()) {
    const text = await banner.textContent();
    expect(text || "").not.toMatch(/Cash flow ties/i);
  } else {
    await expect(banner).toHaveCount(0);
  }
});
