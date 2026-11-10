import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.pw.ts",
  outputDir: "./test-results",
  // Every test runs an example app's real `vite` process in the app's own directory (its .iterbar/ store and its
  // dist/), so the tests run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1200, height: 800 },
    trace: "retain-on-failure",
  },
});
