import { expect, test } from "@playwright/test";

test("demo login: sign in as Raj and get greeted by name", async ({ page, context }) => {
  await context.clearCookies();
  await page.goto("/login");
  await page.getByTestId("login-user").selectOption({ label: "Raj · Owner (admin)" });
  await expect(page.getByTestId("login-submit")).toHaveText("Continue as Raj");
  await page.getByTestId("login-submit").click();
  await page.waitForURL(/\/books/);
  await expect(page.locator("body")).toContainText("Hi Raj", { timeout: 15000 });
});
