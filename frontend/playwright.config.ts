// Browser smoke tests against a RUNNING system (not the Vite unit-test setup):
//   E2E_BASE_URL=https://localhost:8443 npm run e2e      # Compose stack via Caddy
//   npm run e2e                                          # Vite dev server + API + worker
// They create (or reuse) their own account, so registration must be enabled;
// set E2E_EMAIL / E2E_PASSWORD to use an existing account instead.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    ignoreHTTPSErrors: true, // local/CI Caddy uses its own CA
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1180 } },
    },
  ],
});
