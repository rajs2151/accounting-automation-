import { expect, test } from "@playwright/test";

const LAYLA = "44444444-4444-4444-8444-444444444444";
const DESERT = "e1000001-0000-4000-8000-000000000001";

test("close page shows gates; approver can open waive/lock controls", async ({ page, context }) => {
  const host = (() => {
    try {
      return new URL(process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:43123").hostname;
    } catch {
      return "127.0.0.1";
    }
  })();
  await context.addCookies([
    { name: "daftar_user", value: LAYLA, domain: host, path: "/" },
    { name: "daftar_client", value: DESERT, domain: host, path: "/" },
  ]);

  await page.goto("/books/close");
  await expect(page.getByRole("heading", { name: "Month-end close" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Bank / card / gateway statement coverage")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Suspense (1390) closing balance")).toBeVisible();
  await expect(page.getByText("Depreciation")).toBeVisible();
  await expect(page.getByRole("button", { name: /Lock period|Unlock/ })).toBeVisible();
});
