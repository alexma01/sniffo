// Browser UI tests against the real app: see tests-e2e/fixtures.ts and src/dev-bridge.ts.
import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
// Any Chromium works; locally reuse an installed one instead of downloading Playwright's.
const executablePath = process.env.SNIFFO_E2E_BROWSER ?? (existsSync(brave) && !process.env.CI ? brave : undefined);

export default defineConfig({
  testDir: "tests-e2e",
  globalSetup: "./tests-e2e/global-setup.ts",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "target/playwright-report" }]],
  outputDir: "target/playwright-results",
  use: {
    baseURL: "http://localhost:1430",
    viewport: { width: 1500, height: 900 },
    launchOptions: { executablePath },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --port 1430 --strictPort",
    url: "http://localhost:1430",
    reuseExistingServer: !process.env.CI,
  },
});
