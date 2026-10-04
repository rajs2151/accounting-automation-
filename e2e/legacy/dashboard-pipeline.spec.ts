import { expect, test } from "@playwright/test";

test("dashboard shows pipeline table for visible clients", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Books pipeline" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Firm view of clients")).toBeVisible();
  // At least the seeded synthetic clients render when API is healthy.
  await expect(page.locator("table")).toBeVisible();
});
