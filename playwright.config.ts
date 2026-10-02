import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e", fullyParallel: false, workers: 1, timeout: 30000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  webServer: process.env.CI ? { command: "pnpm start", url: "http://localhost:3000/api/v1/health", reuseExistingServer: false, timeout: 30000 } : undefined,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
