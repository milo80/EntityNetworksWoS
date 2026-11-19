// Page-level tests: the whole app (router + React Query) against a fake backend,
// driven through user events.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { App } from "../App";
import { SESSION, mockApi } from "../test/mockApi";
import profile from "../test/synthetic_profile.json";

function renderApp(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const DATASET = {
  id: 7,
  name: "AI in medicine",
  created_at: "2026-11-12T10:00:00Z",
  profile_status: "ready",
  profile_error: null,
  files: [{ id: 1, original_name: "WoS_1.xls", size_bytes: 2 * 1024 * 1024, sha256: "x" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "entitynet_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

describe("login", () => {
  it("redirects to login when logged out, shows server errors, then enters the app", async () => {
    let loggedIn = false;
    mockApi({
      "GET /auth/me": () =>
        loggedIn ? { body: SESSION } : { status: 401, body: { detail: "Not authenticated" } },
      "POST /auth/login": (req) => {
        const { password } = req.body as { password: string };
        if (password !== "right-password") {
          return { status: 401, body: { detail: "Invalid email or password" } };
        }
        loggedIn = true;
        return { body: SESSION };
      },
      "GET /datasets": () => ({ body: [] }),
    });
    const user = renderApp("/datasets");

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "ann@example.org");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "right-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { name: "Datasets" })).toBeInTheDocument();
    expect(screen.getByText("ann@example.org")).toBeInTheDocument();
  });
});

describe("password reset", () => {
  const loggedOut = () => ({ status: 401, body: { detail: "Not authenticated" } });

  it("asks for a link from the login page and shows the neutral answer", async () => {
    const { calls } = mockApi({
      "GET /auth/me": loggedOut,
      "POST /auth/password-reset/request": () => ({
        status: 202,
        body: { detail: "If an account exists for that address, we've sent it a link." },
      }),
    });
    const user = renderApp("/login");
    await user.click(await screen.findByRole("link", { name: "Forgot password?" }));
    await user.type(screen.getByLabelText("Email"), "ann@example.org");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(await screen.findByRole("status")).toHaveTextContent("If an account exists");
    const sent = calls.find((c) => c.path === "/auth/password-reset/request");
    expect(sent?.body).toEqual({ email: "ann@example.org" });
  });

  it("sets a new password with the token from the link", async () => {
    const { calls } = mockApi({
      "GET /auth/me": loggedOut,
      "POST /auth/password-reset/confirm": () => ({ status: 204 }),
    });
    const user = renderApp("/reset-password?token=tok-123");
    await user.type(await screen.findByLabelText("New password"), "a brand new passphrase");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Your password was changed");
    const sent = calls.find((c) => c.path === "/auth/password-reset/confirm");
    expect(sent?.body).toEqual({ token: "tok-123", password: "a brand new passphrase" });
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
  });

  it("explains an expired link and offers a new one", async () => {
    mockApi({
      "GET /auth/me": loggedOut,
      "POST /auth/password-reset/confirm": () => ({
        status: 400,
        body: { detail: "This reset link is invalid or has expired. Ask for a new one." },
      }),
    });
    const user = renderApp("/reset-password?token=old");
    await user.type(await screen.findByLabelText("New password"), "a brand new passphrase");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid or has expired");
    expect(screen.getByRole("link", { name: "Ask for a new link" })).toBeInTheDocument();
  });
});

describe("datasets", () => {
  it("uploads files with the CSRF header and opens the new dataset", async () => {
    document.cookie = "entitynet_csrf=token-123; path=/";
    const { calls } = mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets": () => ({ body: [] }),
      "POST /datasets": () => ({ status: 201, body: { ...DATASET, profile_status: "pending" } }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /runs?dataset_id=7": () => ({ body: [] }),
    });
    const user = renderApp("/datasets");

    await user.click(await screen.findByRole("button", { name: "Upload dataset" }));
    const form = screen.getByRole("form", { name: "Upload dataset" });
    await user.type(within(form).getByLabelText("Name"), "AI in medicine");
    const file = new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], "WoS_1.xls");
    await user.upload(within(form).getByLabelText("WoS export files (.xls)"), file);
    await user.click(within(form).getByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("heading", { name: "AI in medicine" })).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.path === "/datasets")!;
    expect(post.headers.get("X-CSRF-Token")).toBe("token-123");
    const body = post.body as FormData;
    expect(body.get("name")).toBe("AI in medicine");
    expect((body.getAll("files")[0] as File).name).toBe("WoS_1.xls");
  });

  it("builds an institution network with the chosen options", async () => {
    document.cookie = "entitynet_csrf=token-123; path=/";
    const runs: unknown[] = [];
    const { calls } = mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /runs?dataset_id=7": () => ({ body: runs }),
      "POST /runs": (req) => {
        const run = {
          id: 3,
          dataset_id: 7,
          status: "queued",
          error: null,
          node_count: null,
          edge_count: null,
          created_at: "2026-11-12T10:00:00Z",
          started_at: null,
          finished_at: null,
          ...(req.body as object),
          params: { top_n: 150, max_authors: 15, min_shared_keywords: 4, max_keyword_df: 0.2 },
        };
        runs.push(run);
        return { status: 202, body: run };
      },
    });
    const user = renderApp("/datasets/7");

    const form = await screen.findByRole("form", { name: "Build network" });
    await user.selectOptions(within(form).getByLabelText("Relationship"), "institution_keywords");
    expect(within(form).getByLabelText("Maximum nodes")).toHaveValue(150);
    // Parameters are grouped by what they act on; keyword settings are link
    // parameters, shown without opening "More options".
    const links = within(form).getByRole("group", { name: /^Links/ });
    expect(within(form).getByRole("group", { name: /^Nodes/ })).toContainElement(
      within(form).getByLabelText("Maximum nodes"),
    );
    expect(links).toContainElement(within(form).getByLabelText("Minimum shared keywords"));
    expect(within(form).getByLabelText("Minimum shared keywords")).toBeVisible();
    expect(within(form).getByLabelText("Minimum shared keywords")).toHaveAccessibleDescription(
      /share at least this many keywords/,
    );
    await user.clear(within(form).getByLabelText("Minimum shared keywords"));
    await user.type(within(form).getByLabelText("Minimum shared keywords"), "4");
    await user.clear(within(form).getByLabelText("Ignore keywords used by more than (%)"));
    await user.type(within(form).getByLabelText("Ignore keywords used by more than (%)"), "20");
    await user.click(within(form).getByRole("button", { name: "Build network" }));

    const post = calls.find((c) => c.method === "POST" && c.path === "/runs")!;
    expect(post.headers.get("X-CSRF-Token")).toBe("token-123");
    expect(post.body).toEqual({
      dataset_id: 7,
      relation: "institution_keywords",
      params: { top_n: 150, max_authors: 15, min_shared_keywords: 4, max_keyword_df: 0.2 },
    });
    expect(await screen.findByText("Queued")).toBeInTheDocument();
  });

  it("lets a number field be emptied while editing, and blocks building while one is empty", async () => {
    const { calls } = mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /runs?dataset_id=7": () => ({ body: [] }),
    });
    const user = renderApp("/datasets/7");

    const form = await screen.findByRole("form", { name: "Build network" });
    await user.click(within(form).getByText("More options"));
    const maxAuthors = within(form).getByLabelText("Ignore papers with more authors than");
    const build = within(form).getByRole("button", { name: "Build network" });

    // Clearing leaves the field empty (no 0 put back), so 15 -> 8 gives 8, not 08.
    await user.clear(maxAuthors);
    expect(maxAuthors).toHaveDisplayValue("");
    expect(build).toBeDisabled();
    await user.type(maxAuthors, "8");
    expect(maxAuthors).toHaveDisplayValue("8");
    expect(build).toBeEnabled();

    // Left empty: a red message once the field loses focus, and no request.
    await user.clear(maxAuthors);
    await user.tab();
    expect(maxAuthors).toHaveAttribute("aria-invalid", "true");
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "Ignore papers with more authors than: enter a value.",
    );
    expect(build).toBeDisabled();

    // Out of range is caught the same way.
    await user.type(maxAuthors, "1");
    expect(within(form).getByRole("alert")).toHaveTextContent("enter a whole number from 2 to 200");
    expect(calls.some((c) => c.method === "POST" && c.path === "/runs")).toBe(false);
  });

  it("builds a custom network, keeping nodes, link field and model compatible", async () => {
    document.cookie = "entitynet_csrf=token-123; path=/";
    const runs: unknown[] = [];
    const entity = (key: string, label: string, links: string[], available = true) => ({
      key,
      label,
      many_per_article: true,
      available,
      reason: available ? null : "Funding Orgs is filled in only 5% of the articles",
      links,
    });
    const link = (key: string, label: string, kind: string, models: string[]) => ({
      key,
      label,
      kind,
      models,
      available: true,
      reason: null,
    });
    const OPTIONS = {
      entities: [
        entity("institution", "Institution (all authors)", ["keywords", "article_title"]),
        entity("journal", "Journal", ["keywords", "article_title"]),
        entity("funder", "Funder", ["keywords"], false),
      ],
      links: [
        link("keywords", "Keywords", "list", ["word_matching"]),
        link("article_title", "Article title", "string", ["word_overlap", "character_similarity"]),
      ],
      models: [
        {
          key: "word_matching",
          label: "Word matching",
          description: "Shared items.",
          threshold_default: null,
        },
        {
          key: "word_overlap",
          label: "Word overlap",
          description: "Shared words.",
          threshold_default: 0.4,
        },
        {
          key: "character_similarity",
          label: "Characters",
          description: "Spelled alike.",
          threshold_default: 0.85,
        },
      ],
      defaults: {
        entity: "institution",
        link: "keywords",
        model: "word_matching",
        min_shared: 2,
        max_item_df: 0.12,
        threshold: 0.4,
        max_word_df: 0.05,
        min_weight: 1,
        top_n: 300,
        max_authors: 15,
        max_team_categories: 12,
        min_team_size: 2,
      },
    };
    const { calls } = mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /datasets/7/network-options": () => ({ body: OPTIONS }),
      "GET /runs?dataset_id=7": () => ({ body: runs }),
      "POST /runs": (req) => {
        const run = {
          id: 4,
          dataset_id: 7,
          status: "queued",
          error: null,
          node_count: null,
          edge_count: null,
          created_at: "2026-11-12T10:00:00Z",
          started_at: null,
          finished_at: null,
          ...(req.body as object),
        };
        runs.push(run);
        return { status: 202, body: run };
      },
    });
    const user = renderApp("/datasets/7");

    const form = await screen.findByRole("form", { name: "Build network" });
    await user.selectOptions(within(form).getByLabelText("Relationship"), "custom");
    const nodes = await within(form).findByLabelText("Nodes");
    expect(nodes).toHaveValue("institution");
    expect(within(form).getByLabelText("Maximum nodes")).toHaveValue(300);
    expect(within(form).getByLabelText("Minimum shared items")).toHaveValue(2);
    // Unavailable entities are shown but can't be chosen.
    expect(
      within(nodes).getByRole("option", { name: /Funder \(not in this data\)/ }),
    ).toBeDisabled();

    // A string field offers only the string models; choosing one sets its default threshold.
    await user.selectOptions(nodes, "journal");
    await user.selectOptions(within(form).getByLabelText("Linked by"), "article_title");
    const model = within(form).getByLabelText("Model");
    expect(
      within(model)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Word overlap", "Characters"]);
    expect(within(form).getByLabelText("Minimum similarity (%)")).toHaveValue(40);
    await user.selectOptions(model, "character_similarity");
    expect(within(form).getByLabelText("Minimum similarity (%)")).toHaveValue(85);
    expect(within(form).getByText("Spelled alike.")).toBeInTheDocument();

    // The minimum link weight stays at the API default (1, drops nothing).
    expect(within(form).queryByLabelText("Minimum link weight")).toBeNull();

    await user.click(within(form).getByRole("button", { name: "Build network" }));
    const post = calls.find((c) => c.method === "POST" && c.path === "/runs")!;
    expect(post.body).toEqual({
      dataset_id: 7,
      relation: "custom",
      params: {
        top_n: 300,
        max_authors: 15,
        entity: "journal",
        link: "article_title",
        model: "character_similarity",
        min_shared: 2,
        max_item_df: 0.12,
        threshold: 0.85,
        max_word_df: 0.05,
      },
    });
    // The new run is listed with labels from the options.
    expect(await screen.findByText("Journal linked by Article title")).toBeInTheDocument();
  });

  it("shows the data page from a real pipeline profile", async () => {
    mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets": () => ({ body: [DATASET] }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /datasets/7/profile": () => ({ body: { status: "ready", error: null, profile } }),
    });
    const user = renderApp("/datasets/7/data");

    expect(await screen.findByText("Articles")).toBeInTheDocument();
    const overview = screen.getByRole("region", { name: "Overview" });
    expect(within(overview).getByText("6")).toBeInTheDocument();
    expect(within(overview).getByText("2025")).toBeInTheDocument();

    const countries = screen.getByRole("region", { name: "Countries (corresponding author)" });
    expect(within(countries).getByText("Peoples R China")).toBeInTheDocument();

    const sample = screen.getByRole("region", { name: "Sample" });
    expect(within(sample).getAllByRole("columnheader")).toHaveLength(7);
    await user.click(within(sample).getByRole("button", { name: /Show all 11 columns/ }));
    expect(within(sample).getAllByRole("columnheader")).toHaveLength(11);
    expect(within(sample).getAllByRole("row")).toHaveLength(1 + 6);
  });
});

describe("navigation", () => {
  const OLDER = { ...DATASET, id: 3, name: "Older export", created_at: "2026-10-01T10:00:00Z" };
  const PENDING = {
    ...DATASET,
    id: 9,
    name: "Still analysing",
    created_at: "2026-11-01T10:00:00Z",
    profile_status: "pending",
  };
  const nav = () => screen.getByRole("navigation", { name: "Main" });

  it("shows the title as plain text and marks the Datasets tab", async () => {
    mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets": () => ({ body: [DATASET] }),
    });
    renderApp("/datasets");

    expect(await screen.findByRole("heading", { name: "Datasets" })).toBeInTheDocument();
    expect(screen.getByText("EntityNetworks")).not.toHaveAttribute("href");
    expect(screen.queryByRole("link", { name: "EntityNetworks" })).toBeNull();
    expect(within(nav()).getByRole("link", { name: "Datasets" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // No dataset in the URL: View data opens the newest dataset (via /data).
    expect(within(nav()).getByRole("link", { name: "View data" })).toHaveAttribute("href", "/data");
  });

  it("/data opens the newest dataset, listing all of them", async () => {
    mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets": () => ({ body: [OLDER, DATASET, PENDING] }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /datasets/7/profile": () => ({ body: { status: "ready", error: null, profile } }),
      "GET /datasets/3": () => ({ body: OLDER }),
      "GET /datasets/3/profile": () => ({ body: { status: "ready", error: null, profile } }),
    });
    const user = renderApp("/data");

    const list = await screen.findByRole("navigation", { name: "Datasets" });
    await within(list).findByRole("link", { name: /AI in medicine/ });
    expect(
      within(list)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual([
      expect.stringContaining("AI in medicine"),
      expect.stringContaining("Still analysing"),
      expect.stringContaining("Older export"),
    ]);
    expect(within(list).getByRole("link", { name: /AI in medicine/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(list).getByRole("link", { name: /Still analysing/ })).toHaveTextContent(
      /Analys/i,
    );
    const viewData = within(nav()).getByRole("link", { name: "View data" });
    expect(viewData).toHaveAttribute("aria-current", "page");
    expect(viewData).toHaveAttribute("href", "/datasets/7/data");
    expect(within(nav()).getByRole("link", { name: "Datasets" })).not.toHaveAttribute(
      "aria-current",
    );

    await user.click(within(list).getByRole("link", { name: /Older export/ }));
    expect(await screen.findByRole("link", { name: "← Older export" })).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: /Older export/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("/data without datasets points to the upload", async () => {
    mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets": () => ({ body: [] }),
    });
    renderApp("/data");

    expect(await screen.findByText(/No datasets yet/)).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(
      screen.getAllByRole("link", { name: "Datasets" }).find((a) => !nav().contains(a))!,
    );
  });
});
