import { defineConfig } from "@playwright/test";

/** Against running compose `web` — no rebuild / no e2e DB remigrate. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/books-phase1.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://web:43123",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
  },
});
