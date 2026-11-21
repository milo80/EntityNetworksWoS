// The main user journey in a real browser: log in, upload WoS files, build a
// network, explore it, delete the dataset. Also fails on any console error or
// uncaught exception - which is how a Content-Security-Policy violation shows up.
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
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
  await page.getByRole("main").getByRole("link", { name: "View data" }).click();
  const overview = page.getByRole("region", { name: "Overview" });
  await expect(overview.getByText("Articles", { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.goBack();

  // Build a co-authorship network (the panel opens once a relationship is
  // chosen) and wait for the worker.
  const build = page.getByRole("form", { name: "Build network" });
  await build.getByLabel("Relationship").selectOption("author");
  await build.getByRole("button", { name: "Build network" }).click();
  // The run row's button (in main), not the Explore tab in the top bar.
  await page.getByRole("main").getByRole("link", { name: "Explore" }).click({ timeout: 60_000 });

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

// REQ-REC-5: from a keyword link between two institutions to the records behind
// it. The dataset and network are set up through the API (the journey above
// covers the forms); the check itself goes through the UI.
test("check a link's records from the explorer", async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();

  const csrf = (await page.context().cookies()).find((c) => c.name === "entitynet_csrf")!.value;
  const headers = { "X-CSRF-Token": csrf };
  const upload = await page.request.post("/api/datasets", {
    headers,
    multipart: {
      name: `e2e records ${testInfo.project.name} ${Date.now()}`,
      files: {
        name: "synthetic_wos.xls",
        mimeType: "application/vnd.ms-excel",
        buffer: fs.readFileSync(XLS),
      },
    },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const dataset = (await upload.json()) as { id: number };
  try {
    // Institutions linked by 3 shared keywords (all items eligible on 6 articles).
    const created = await page.request.post("/api/runs", {
      headers,
      data: {
        dataset_id: dataset.id,
        relation: "custom",
        params: { entity: "institution", link: "keywords", min_shared: 3, max_item_df: 1 },
      },
    });
    expect(created.status(), await created.text()).toBe(202);
    const run = (await created.json()) as { id: number };
    await expect
      .poll(async () => (await (await page.request.get(`/api/runs/${run.id}`)).json()).status, {
        timeout: 60_000,
      })
      .toBe("succeeded");

    await page.goto(`/runs/${run.id}`);
    await expect(page.getByText(/^Laying out/)).toBeHidden({ timeout: 30_000 });
    // Links are drawn on a canvas: select one through Cytoscape, as a tap would.
    const shared = await page.locator(".graph-canvas").evaluate((el) => {
      type Cy = {
        edges: () => { length: number; first: () => { emit: (e: string) => void } };
      };
      const cy = (el as unknown as { _cyreg: { cy: Cy } })._cyreg.cy;
      const edges = cy.edges();
      if (!edges.length) return false;
      edges.first().emit("tap");
      return true;
    });
    expect(shared, "the network has a link").toBe(true);
    const toggle = page.getByRole("button", { name: "Details" });
    if (await toggle.isVisible()) await toggle.click(); // tablet: the panel is a drawer
    const details = page.getByRole("complementary", { name: "Details" });
    await expect(details.getByRole("heading", { level: 2 })).toContainText(" — ");
    await details.getByRole("link", { name: "Show records" }).click();

    await expect(page.getByRole("heading", { name: "Records" })).toBeVisible();
    await expect(page.getByText(/keeps at most 20 shared items per link/)).toBeVisible();
    await expect(page.getByText(/^[1-9]\d* of 6 records$/)).toBeVisible();
    const table = page.getByRole("table");
    await expect(
      table.getByRole("columnheader", { name: /Keywords \(normalized\)/ }),
    ).toBeVisible();
    // The shared keywords are highlighted in the records that carry them.
    const marks = table.locator("td mark");
    await expect(marks.first()).toBeVisible();
    const marked = await marks.allTextContents();
    expect(
      marked.some((m) => /ultrasound|learning|oncology|failure|citespace|bibliometric/.test(m)),
    ).toBe(true);
    await testInfo.attach("records", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await page.request.delete(`/api/datasets/${dataset.id}`, { headers });
  }
  expect(errors).toEqual([]);
});
