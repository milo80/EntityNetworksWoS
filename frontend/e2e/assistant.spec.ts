// The assistant in a real browser. CI has no Anthropic key, so the assistant's
// endpoints are stood in for with page.route: these tests check the UI and what
// it does with a reply (the API side is in backend/tests/api/test_api_assistant.py).
// The dataset, the build and the explorer are real.
import { expect, test, type Page, type Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const XLS = path.resolve(import.meta.dirname, "../../backend/tests/fixtures/synthetic_wos.xls");
const EMAIL = process.env.E2E_EMAIL ?? "e2e@example.org";
const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-123456";

interface ChatBody {
  messages: { role: string; text: string }[];
  context: { page: string; dataset_id: number | null; run_id: number | null };
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("status of 401")) {
      errors.push(`console: ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => errors.push(`page: ${e.message}`));
  return errors;
}

test.beforeAll(async ({ request }) => {
  if (process.env.E2E_EMAIL) return;
  const creds = { data: { email: EMAIL, password: PASSWORD } };
  if ((await request.post("/api/auth/login", creds)).ok()) return;
  const r = await request.post("/api/auth/register", creds);
  expect([201, 409], await r.text()).toContain(r.status());
});

/** Turns the assistant on and answers each question with `reply(body)`. */
async function standInForAssistant(page: Page, reply: (body: ChatBody) => object) {
  const sent: ChatBody[] = [];
  await page.route("**/api/assistant/status", (route: Route) =>
    route.fulfill({ json: { enabled: true } }),
  );
  await page.route("**/api/assistant/chat", async (route: Route) => {
    const body = route.request().postDataJSON() as ChatBody;
    sent.push(body);
    await route.fulfill({ json: { reply: "", proposal: null, actions: [], ...reply(body) } });
  });
  return sent;
}

async function logIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();
  const csrf = (await page.context().cookies()).find((c) => c.name === "entitynet_csrf")!.value;
  return { "X-CSRF-Token": csrf };
}

async function uploadDataset(page: Page, headers: Record<string, string>, label: string) {
  const upload = await page.request.post("/api/datasets", {
    headers,
    multipart: {
      name: `e2e assistant ${label} ${Date.now()}`,
      files: {
        name: "synthetic_wos.xls",
        mimeType: "application/vnd.ms-excel",
        buffer: fs.readFileSync(XLS),
      },
    },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  return (await upload.json()) as { id: number };
}

async function waitForRun(page: Page, runId: number) {
  await expect
    .poll(async () => (await (await page.request.get(`/api/runs/${runId}`)).json()).status, {
      timeout: 60_000,
    })
    .toBe("succeeded");
}

async function ask(page: Page, question: string) {
  const panel = page.getByRole("complementary", { name: "Assistant" });
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Assistant" }).click();
  await panel.getByLabel("Message").fill(question);
  await panel.getByRole("button", { name: "Send" }).click();
  return panel;
}

test("ask the assistant what a link model means", async ({ page }) => {
  const errors = collectErrors(page);
  const sent = await standInForAssistant(page, () => ({
    reply: "A link model decides when two articles match on the link field.",
  }));
  await logIn(page);

  const panel = await ask(page, "What does a link model mean?");
  await expect(panel.getByText("What does a link model mean?")).toBeVisible();
  await expect(
    panel.getByText("A link model decides when two articles match on the link field."),
  ).toBeVisible();
  await expect(
    panel.getByText("Your messages are sent to Anthropic's Claude.", { exact: false }),
  ).toBeVisible();
  // Beside the page, which stays.
  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();
  expect(sent).toEqual([
    {
      messages: [{ role: "user", text: "What does a link model mean?" }],
      context: { page: "datasets", dataset_id: null, run_id: null },
    },
  ]);
  expect(errors).toEqual([]);
});

test("build a network from an assistant proposal", async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  const sent = await standInForAssistant(page, (body) => ({
    reply: "Institutions linked by shared keywords. Check the settings and click Build.",
    proposal: {
      dataset_id: body.context.dataset_id,
      entity: "institution",
      link: "keywords",
      model: "word_matching",
      top_n: 120,
      min_weight: 1,
      min_shared: 1,
      max_item_df: 1,
      threshold: null,
      max_word_df: null,
      summary: "Institution (all authors) linked by Keywords, word matching, at least 1 shared",
    },
  }));
  const headers = await logIn(page);
  const dataset = await uploadDataset(page, headers, `build ${testInfo.project.name}`);
  try {
    await page.goto(`/datasets/${dataset.id}`);
    const form = page.getByRole("form", { name: "Build network" });
    await expect(form).toBeVisible();

    const panel = await ask(page, "Institutions that share keywords");
    await expect(panel.getByText("Filled in the Build network form.")).toBeVisible();
    await expect(form.getByRole("status")).toHaveText(
      "Suggested by the assistant. Check the settings and click Build.",
    );
    await expect(form.getByLabel("Relationship")).toHaveValue("custom");
    await expect(form.getByLabel("Maximum nodes")).toHaveValue("120");
    await expect(form.getByLabel("Maximum nodes")).toHaveClass(/suggested/);
    await expect(form.getByLabel("Minimum shared items")).toHaveValue("1");
    await expect(form.getByLabel("Ignore items used by more than (%)")).toHaveValue("100");
    // Nothing was built yet.
    const before = await (await page.request.get(`/api/runs?dataset_id=${dataset.id}`)).json();
    expect(before).toEqual([]);
    expect(sent[0]!.context).toEqual({ page: "dataset", dataset_id: dataset.id, run_id: null });

    await page.getByRole("button", { name: "Close" }).click();
    await form.getByRole("button", { name: "Build network" }).click();
    await expect
      .poll(async () => (await page.request.get(`/api/runs?dataset_id=${dataset.id}`)).json())
      .toHaveLength(1);
    const [run] = (await (await page.request.get(`/api/runs?dataset_id=${dataset.id}`)).json()) as {
      id: number;
      params: Record<string, unknown>;
    }[];
    expect(run!.params).toMatchObject({
      entity: "institution",
      link: "keywords",
      model: "word_matching",
      top_n: 120,
      min_shared: 1,
      max_item_df: 1,
    });
    await waitForRun(page, run!.id);
  } finally {
    await page.request.delete(`/api/datasets/${dataset.id}`, { headers });
  }
  expect(errors).toEqual([]);
});

test("filter the explorer by chat", async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  const sent = await standInForAssistant(page, () => ({
    reply: "Here are the largest group and the nodes that keep a link.",
    actions: [
      { kind: "keep_largest_groups", n: 1 },
      { kind: "set_hide_unlinked", on: true },
    ],
  }));
  const headers = await logIn(page);
  const dataset = await uploadDataset(page, headers, `explore ${testInfo.project.name}`);
  try {
    const created = await page.request.post("/api/runs", {
      headers,
      data: {
        dataset_id: dataset.id,
        relation: "custom",
        params: { entity: "institution", link: "keywords", min_shared: 1, max_item_df: 1 },
      },
    });
    expect(created.status(), await created.text()).toBe(202);
    const run = (await created.json()) as { id: number };
    await waitForRun(page, run.id);

    await page.goto(`/runs/${run.id}`);
    await expect(page.getByText(/^Laying out/)).toBeHidden({ timeout: 30_000 });
    const counts = page.getByText(/^\d+ of \d+ nodes · \d+ of \d+ links shown$/);
    const [, total] = /^\d+ of (\d+) nodes/.exec((await counts.textContent())!)!;
    await expect(counts).toHaveText(new RegExp(`^${total} of ${total} nodes`));

    const panel = await ask(page, "Only the largest group, without unlinked nodes");
    const lines = panel.getByRole("list", { name: "Applied in the explorer" });
    await expect(lines.getByRole("listitem")).toHaveText([
      "Showing the largest group",
      "Hiding nodes without visible links",
    ]);
    await expect(counts).not.toHaveText(new RegExp(`^${total} of ${total} nodes`));
    expect(sent[0]!.context).toEqual({ page: "explorer", dataset_id: dataset.id, run_id: run.id });

    // The controls show the change and can be changed by hand.
    await page.getByRole("button", { name: "Close" }).click();
    const toggle = page.getByRole("button", { name: "Filters" });
    if (await toggle.isVisible()) await toggle.click(); // tablet: the panel is a drawer
    const filters = page.getByRole("complementary", { name: "Filters" });
    const groups = filters.getByRole("group", { name: /Group/ }).getByRole("checkbox");
    await expect(groups.first()).toBeChecked();
    await expect(groups.nth(1)).not.toBeChecked();
    const hide = filters.getByLabel("Hide nodes without visible links");
    await expect(hide).toBeChecked();
    await filters.getByRole("button", { name: "Show all" }).click();
    await hide.uncheck();
    await expect(counts).toHaveText(new RegExp(`^${total} of ${total} nodes`));
    await testInfo.attach("explorer", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await page.request.delete(`/api/datasets/${dataset.id}`, { headers });
  }
  expect(errors).toEqual([]);
});
