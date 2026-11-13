// The main user journey in a real browser: log in, upload WoS files, build a
// network, explore it, delete the dataset. Also fails on any console error or
// uncaught exception - which is how a Content-Security-Policy violation shows up.
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const XLS = path.resolve(import.meta.dirname, "../../backend/tests/fixtures/synthetic_wos.xls");
const EMAIL = process.env.E2E_EMAIL ?? "e2e@example.org";
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-123456";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    // The session check before login answers 401 by design; Chromium logs it.
    if (m.type() === "error" && !m.text().includes("status of 401")) {
      errors.push(`console: ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => errors.push(`page: ${e.message}`));
  return errors;
}

test.beforeAll(async ({ request }) => {
  if (process.env.E2E_EMAIL) return;
  // Register only once: registration is rate-limited (5/min), login isn't as tight.
  const creds = { data: { email: EMAIL, password: PASSWORD } };
  if ((await request.post("/api/auth/login", creds)).ok()) return;
  const r = await request.post("/api/auth/register", creds);
  expect([201, 409], await r.text()).toContain(r.status());
});

test("upload, build and explore a network", async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  page.on("dialog", (d) => d.accept()); // "Delete dataset?" confirmation

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();

  const name = `e2e ${testInfo.project.name} ${Date.now()}`;
  await page.getByRole("button", { name: "Upload dataset" }).click();
  const form = page.getByRole("form", { name: "Upload dataset" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("WoS export files (.xls)").setInputFiles(XLS);
  await form.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  // Data page: the worker profiles the upload.
  await page.getByRole("link", { name: "View data" }).click();
  const overview = page.getByRole("region", { name: "Overview" });
  await expect(overview.getByText("Articles", { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.goBack();

  // Build the default (co-authorship) network and wait for the worker.
  await page
    .getByRole("form", { name: "Build network" })
    .getByRole("button", { name: "Build network" })
    .click();
  await page.getByRole("link", { name: "Explore" }).click({ timeout: 60_000 });

  await expect(page.getByText(/^Laying out/)).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText(/^\d+ of \d+ nodes · \d+ of \d+ links shown$/)).toBeVisible();
  await expect(page.locator(".graph-canvas canvas").first()).toBeVisible();
  await testInfo.attach("explorer", { body: await page.screenshot(), contentType: "image/png" });

  // Clean up through the UI.
  await page.goBack();
  await page.getByRole("button", { name: "Delete dataset" }).click();
  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();
  await expect(page.getByRole("link", { name })).toHaveCount(0);

  expect(errors).toEqual([]);
});
