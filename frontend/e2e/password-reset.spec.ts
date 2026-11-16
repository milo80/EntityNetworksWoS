// Password reset in a real browser: ask for a link, open it, set a new password,
// log in with it; the old password and a second use of the link must fail.
//
// Without SMTP_HOST the API logs the email instead of sending it, so the link is
// read from the API log. E2E_API_LOGS_CMD is a shell command that prints that log
// (in CI: `docker compose logs --no-color api`, run from deploy/). Edge cases
// (expiry, newer link voids older, unknown email) are in
// backend/tests/api/test_api_password_reset.py.
import { expect, test, type Page } from "@playwright/test";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const LOGS_CMD = process.env.E2E_API_LOGS_CMD;
const OLD_PASSWORD = "e2e-old-password-123456";
const NEW_PASSWORD = "e2e-new-password-654321";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    // 401 (session check, wrong password) and 400 (used link) are expected here.
    if (m.type() === "error" && !/status of (400|401)/.test(m.text())) {
      errors.push(`console: ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => errors.push(`page: ${e.message}`));
  return errors;
}

/** Token of the newest reset link logged for `email`, or null if none yet. */
async function latestResetToken(email: string): Promise<string | null> {
  const { stdout } = await promisify(exec)(LOGS_CMD!, { maxBuffer: 64 * 1024 * 1024 });
  // The logged email spans several lines (each may carry a "api-1  | " prefix):
  // a header line "...email NOT sent. To: <email> | Subject: ..." then the body.
  let ours = false;
  let token: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.includes("email NOT sent. To: ")) ours = line.includes(`To: ${email} |`);
    const m = ours && /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(line);
    if (m) token = m[1];
  }
  return token;
}

async function waitForResetToken(email: string): Promise<string> {
  const deadline = Date.now() + 30_000; // the email goes out in a background task
  for (;;) {
    const token = await latestResetToken(email);
    if (token) return token;
    if (Date.now() > deadline) throw new Error(`no reset link for ${email} in the API log`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

async function logIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

test("reset a forgotten password by emailed link", async ({ page, request }, testInfo) => {
  test.skip(
    !LOGS_CMD,
    "Set E2E_API_LOGS_CMD to a shell command that prints the API log " +
      "(e.g. `docker compose logs --no-color api` run in deploy/) to read the reset link.",
  );
  // Asking for a link and confirming share one rate limit (5/min per client),
  // and this flow uses 3; running it in every project would exceed it.
  test.skip(
    testInfo.project.name !== testInfo.config.projects[0].name,
    `Runs once, in the "${testInfo.config.projects[0].name}" project (password reset rate limit).`,
  );
  const errors = collectErrors(page);

  const email = `reset-${testInfo.project.name}-${Date.now()}@example.org`;
  const r = await request.post("/api/auth/register", {
    data: { email, password: OLD_PASSWORD },
  });
  expect(r.status(), await r.text()).toBe(201);

  // Ask for a link.
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Forgot password" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(/If an account exists for that address/);

  // Open it (relative to the base URL: the logged link uses PUBLIC_BASE_URL)
  // and choose a new password.
  const resetPath = `/reset-password?token=${await waitForResetToken(email)}`;
  await page.goto(resetPath);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("heading", { name: "Password changed" })).toBeVisible();

  // The old password no longer works; the new one does.
  await logIn(page, email, OLD_PASSWORD);
  await expect(page.getByRole("alert")).toHaveText("Invalid email or password");
  await logIn(page, email, NEW_PASSWORD);
  await expect(page.getByRole("heading", { name: "Datasets" })).toBeVisible();

  // The link works once.
  await page.goto(resetPath);
  await page.getByLabel("New password").fill("e2e-third-password-000000");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("alert")).toContainText("This reset link is invalid or has expired");

  expect(errors).toEqual([]);
});
