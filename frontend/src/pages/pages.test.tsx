// Page-level tests: the whole app (router + React Query) against a fake backend,
// driven through user events.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { App } from "../App";
import { clearFormState } from "../lib/buildFormState";
import { forgetNetwork, rememberNetwork } from "../lib/lastNetwork";
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

/** Unmount between two renders in one test (a reload, or another page). */
function cleanupApp() {
  cleanup();
  vi.unstubAllGlobals();
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearFormState();
  forgetNetwork();
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
    await user.selectOptions(within(form).getByLabelText("Relationship"), "author");
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
    const attribute = (key: string, label: string, fill: number | null, notFor: string[] = []) => ({
      key,
      label,
      attr_key: key.toLowerCase().replace(/ /g, "_"),
      fill_pct: fill,
      not_for: notFor,
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
      attributes: [
        attribute("country", "Country (from Addresses)", null, ["country"]),
        attribute("articles", "Articles (count)", null),
        attribute("Research Areas", "Research Areas", 100),
        attribute("Publication Year", "Publication Year", 100),
        attribute("Publisher", "Publisher", 98.5),
        attribute("Source Title", "Source Title", 100, ["journal"]),
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
        node_attributes: ["Research Areas", "country", "Publication Year", "Source Title"],
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

    // Node attributes for attribute search: the defaults are listed; a field the
    // nodes already are (journal nodes from Source Title) is marked, not dropped.
    const list = within(form).getByRole("list", { name: "Attributes for search" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent?.replace("−", "")),
    ).toEqual([
      "Research Areas",
      "Country (from Addresses)",
      "Publication Year",
      "Source Title (same field as the nodes)",
    ]);
    // − removes; + opens the catalogue of every field not yet chosen.
    await user.click(within(list).getByRole("button", { name: "Remove Publication Year" }));
    await user.click(within(form).getByRole("button", { name: "Add a field" }));
    const catalogue = within(form).getByRole("dialog", { name: "Fields" });
    expect(
      within(catalogue)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Add Articles (count)", "Add Publication Year", "Add Publisher"]);
    expect(within(catalogue).getByText("98.5%")).toBeInTheDocument();
    await user.type(within(catalogue).getByLabelText("Filter fields"), "publ");
    await user.click(within(catalogue).getByRole("button", { name: "Add Publisher" }));
    await user.keyboard("{Escape}");
    expect(within(form).queryByRole("dialog", { name: "Fields" })).toBeNull();

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
        node_attributes: ["Research Areas", "country", "Source Title", "Publisher"],
      },
    });
    // The new run is listed with labels from the options.
    expect(await screen.findByText("Journal linked by Article title")).toBeInTheDocument();
  });

  it("shows the chosen node type's and link field's catalog values beside a custom build", async () => {
    // Country with 15 values: the build form shows them all (up to 20), the data page 10.
    const many = structuredClone(profile);
    const country = many.stats.catalog.find((e) => e.key === "country")!;
    country.top = Array.from({ length: 15 }, (_, i) => ({
      value: `Country ${i + 1}`,
      count: 15 - i,
    }));
    const entity = (key: string, label: string, links: string[]) => ({
      key,
      label,
      many_per_article: true,
      available: true,
      reason: null,
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
        entity("institution", "Institution (all authors)", ["keywords", "authors", "same_article"]),
        entity("country", "Country", ["keywords", "same_article"]),
        entity("article", "Article", ["keywords", "article_title"]),
      ],
      links: [
        link("same_article", "Same article", "same_article", []),
        link("keywords", "Keywords", "list", ["word_matching"]),
        link("authors", "Authors", "list", ["word_matching"]),
        link("article_title", "Article title", "string", ["word_overlap"]),
      ],
      models: [
        { key: "word_matching", label: "Word matching", description: "", threshold_default: null },
        { key: "word_overlap", label: "Word overlap", description: "", threshold_default: 0.4 },
      ],
      attributes: [],
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
    mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets": () => ({ body: [DATASET] }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /datasets/7/network-options": () => ({ body: OPTIONS }),
      "GET /datasets/7/profile": () => ({ body: { status: "ready", error: null, profile: many } }),
      "GET /runs?dataset_id=7": () => ({ body: [] }),
    });
    const user = renderApp("/datasets/7");

    const form = await screen.findByRole("form", { name: "Build network" });
    // Not for the fixed relationships.
    await user.selectOptions(within(form).getByLabelText("Relationship"), "author");
    expect(screen.queryByRole("complementary", { name: "Node values" })).toBeNull();

    await user.selectOptions(within(form).getByLabelText("Relationship"), "custom");
    const nodeSide = await screen.findByRole("complementary", { name: "Node values" });
    const linkSide = screen.getByRole("complementary", { name: "Link field values" });
    const values = (side: HTMLElement) =>
      within(side)
        .queryAllByRole("listitem")
        .map((li) => li.querySelector(".bar-label")!.textContent);
    expect(within(nodeSide).getByText("Nodes · fine-grained")).toBeInTheDocument();
    expect(values(nodeSide)).toEqual(["Mayo Clin", "Univ Parma", "Peking Univ", "Fudan Univ"]);
    expect(
      within(linkSide).getByRole("heading", { name: /Keywords \(author keywords/ }),
    ).toBeInTheDocument();
    expect(values(linkSide)).toContain("fetal ultrasound");

    // The Nodes options are grouped like the catalog, and the select shows its group color.
    const nodes = within(form).getByLabelText("Nodes");
    expect(
      within(nodes)
        .getAllByRole("group")
        .map((g) => g.getAttribute("label")),
    ).toEqual(["Fine-grained", "Coarse", "Other"]);
    expect(nodes).toHaveClass("select-marked");

    await user.selectOptions(nodes, "country");
    expect(within(nodeSide).getByText("Nodes · coarse")).toBeInTheDocument();
    expect(values(nodeSide)).toHaveLength(15);

    // A link field that is a node type's own column shows that node's values;
    // co-occurrence and text fields describe what they contain.
    await user.selectOptions(nodes, "institution");
    const linkedBy = within(form).getByLabelText("Linked by");
    await user.selectOptions(linkedBy, "authors");
    expect(within(linkSide).getByText(/same values as Author/)).toBeInTheDocument();
    expect(values(linkSide)).toContain("Rossi, Anna");
    await user.selectOptions(linkedBy, "same_article");
    expect(
      within(linkSide).getByText(/Links nodes that appear on the same article/),
    ).toBeInTheDocument();
    await user.selectOptions(nodes, "article");
    expect(within(nodeSide).getByText("One node per article.")).toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText("Linked by"), "article_title");
    expect(within(linkSide).getByText(/^Text, typically \d+ words/)).toBeInTheDocument();

    // The data page keeps the top 10.
    await user.click(within(screen.getByRole("main")).getByRole("link", { name: "View data" }));
    const coarse = await screen.findByRole("region", { name: "Nodes · coarse" });
    expect(
      within(within(coarse).getByRole("region", { name: "Country" })).getAllByRole("listitem"),
    ).toHaveLength(10);
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

    // Catalog: node types grouped by granularity with their top values, and the
    // fields that can link them.
    const catalog = screen.getByRole("region", { name: "Catalog" });
    const fine = within(catalog).getByRole("region", { name: "Nodes · fine-grained" });
    const coarse = within(catalog).getByRole("region", { name: "Nodes · coarse" });
    expect(within(fine).getByRole("region", { name: "Author" })).toBeInTheDocument();
    expect(within(fine).getByRole("region", { name: "Journal" })).toHaveTextContent(
      "Journal of Tests",
    );
    const country = within(coarse).getByRole("region", { name: "Country" });
    expect(country).toHaveTextContent("Coarse node · 3 distinct · on 100% of articles");
    expect(within(country).getByText("Peoples R China")).toBeInTheDocument();
    expect(within(fine).queryByRole("region", { name: "Country" })).toBeNull();

    const linkedBy = within(catalog).getByRole("region", { name: "Linked by" });
    expect(within(linkedBy).getByRole("region", { name: "Author keywords" })).toHaveTextContent(
      "fetal ultrasound",
    );
    const others = within(linkedBy).getByRole("table", { name: "Other link fields" });
    const authorsRow = within(others).getByRole("row", { name: /^Authors/ });
    expect(authorsRow).toHaveTextContent("same values as Author");
    expect(within(authorsRow).getByRole("link", { name: "Author" })).toHaveAttribute(
      "href",
      "#bars-author",
    );
    expect(within(others).getByRole("row", { name: /^Article title/ })).toHaveTextContent(
      "Text, typically 3 words",
    );
    expect(within(others).getByRole("row", { name: /^Same article/ })).toHaveTextContent(
      "Co-occurrence",
    );
    // The keyword lists moved into Linked by: not repeated below.
    expect(screen.getAllByRole("region", { name: "Author keywords" })).toHaveLength(1);
    // Replaced by the catalog.
    for (const name of [
      "Countries (corresponding author)",
      "Institutions (corresponding author)",
    ]) {
      expect(screen.queryByRole("region", { name })).toBeNull();
    }

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
    expect(screen.getByText("Entity Networks")).not.toHaveAttribute("href");
    expect(screen.queryByRole("link", { name: "Entity Networks" })).toBeNull();
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

describe("explore tab", () => {
  const nav = () => screen.getByRole("navigation", { name: "Main" });
  const run = (id: number, status: string, created_at: string) => ({
    id,
    dataset_id: 7,
    relation: "author",
    params: {},
    status,
    error: null,
    node_count: null,
    edge_count: null,
    created_at,
    started_at: null,
    finished_at: null,
  });

  it("opens the dataset's newest finished network and marks the Explore tab", async () => {
    mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets": () => ({ body: [DATASET] }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /runs?dataset_id=7": () => ({
        body: [
          run(4, "succeeded", "2026-11-12T10:00:00Z"),
          run(6, "failed", "2026-11-14T10:00:00Z"),
          run(5, "succeeded", "2026-11-13T10:00:00Z"),
        ],
      }),
      // Not finished by the time it opens: the page says so (no graph needed here).
      "GET /runs/5": () => ({ body: run(5, "running", "2026-11-13T10:00:00Z") }),
    });
    renderApp("/explore");

    expect(await screen.findByText("This network is running.")).toBeInTheDocument();
    const explore = within(nav()).getByRole("link", { name: "Explore" });
    expect(explore).toHaveAttribute("aria-current", "page");
    // The open network's dataset drives the other tabs.
    expect(explore).toHaveAttribute("href", "/explore?dataset=7");
    expect(within(nav()).getByRole("link", { name: "View data" })).toHaveAttribute(
      "href",
      "/datasets/7/data",
    );
    expect(within(nav()).getByRole("link", { name: "Datasets" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("returns to the network last opened for that dataset", async () => {
    rememberNetwork({ runId: 9, datasetId: 7 });
    mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /runs/9": () => ({ body: run(9, "queued", "2026-11-13T10:00:00Z") }),
    });
    renderApp("/explore?dataset=7");
    expect(await screen.findByText("This network is queued.")).toBeInTheDocument();
  });

  it("points to building one when the dataset has no finished network", async () => {
    rememberNetwork({ runId: 9, datasetId: 3 }); // another dataset's
    mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /runs?dataset_id=7": () => ({ body: [run(6, "failed", "2026-11-14T10:00:00Z")] }),
    });
    renderApp("/explore?dataset=7");
    expect(await screen.findByText("No network built for this dataset yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create one" })).toHaveAttribute("href", "/datasets/7");
  });

  it("links to Explore with the dataset from a dataset page", async () => {
    mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets": () => ({ body: [DATASET] }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /datasets/7/network-options": () => ({ status: 404, body: { detail: "x" } }),
      "GET /datasets/7/profile": () => ({ body: { status: "ready", error: null, profile } }),
      "GET /runs?dataset_id=7": () => ({ body: [] }),
    });
    renderApp("/datasets/7");
    await screen.findByRole("heading", { name: "AI in medicine" });
    expect(within(nav()).getByRole("link", { name: "Explore" })).toHaveAttribute(
      "href",
      "/explore?dataset=7",
    );
  });
});

describe("build network panel", () => {
  const RUN = {
    id: 5,
    dataset_id: 7,
    relation: "author",
    params: { top_n: 700, max_authors: 15 },
    status: "queued",
    error: null,
    node_count: null,
    edge_count: null,
    created_at: "2026-11-12T10:00:00Z",
    started_at: null,
    finished_at: null,
  };

  function mockDataset() {
    const runs: unknown[] = [];
    return mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets": () => ({ body: [DATASET] }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /datasets/7/profile": () => ({ body: { status: "ready", error: null, profile } }),
      "GET /runs?dataset_id=7": () => ({ body: runs }),
      "POST /runs": () => {
        runs.push(RUN);
        return { status: 202, body: RUN };
      },
    });
  }

  it("starts collapsed and opens when a relationship is chosen", async () => {
    mockDataset();
    const user = renderApp("/datasets/7");

    const form = await screen.findByRole("form", { name: "Build network" });
    expect(within(form).getByRole("heading", { name: "Create network" })).toBeInTheDocument();
    expect(within(form).getByLabelText("Relationship")).toHaveValue("");
    expect(within(form).queryByLabelText("Maximum nodes")).toBeNull();
    expect(within(form).queryByRole("button", { name: "Build network" })).toBeNull();

    await user.selectOptions(within(form).getByLabelText("Relationship"), "author");
    expect(within(form).getByLabelText("Maximum nodes")).toHaveValue(700);
    expect(within(form).getByRole("button", { name: "Build network" })).toBeEnabled();

    // Hide/Show folds the panel without losing the edits.
    await user.clear(within(form).getByLabelText("Maximum nodes"));
    await user.type(within(form).getByLabelText("Maximum nodes"), "250");
    await user.click(within(form).getByRole("button", { name: "Hide settings" }));
    expect(within(form).queryByLabelText("Maximum nodes")).toBeNull();
    await user.click(within(form).getByRole("button", { name: "Show settings" }));
    expect(within(form).getByLabelText("Maximum nodes")).toHaveValue(250);
  });

  it("keeps the panel as it was after visiting View data", async () => {
    mockDataset();
    const user = renderApp("/datasets/7");

    let form = await screen.findByRole("form", { name: "Build network" });
    await user.selectOptions(within(form).getByLabelText("Relationship"), "institution_keywords");
    await user.clear(within(form).getByLabelText("Minimum shared keywords"));
    await user.type(within(form).getByLabelText("Minimum shared keywords"), "5");
    await user.click(within(form).getByText("More options"));

    await user.click(within(screen.getByRole("main")).getByRole("link", { name: "View data" }));
    expect(await screen.findByRole("heading", { name: "Data" })).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", {
        name: "Datasets",
      }),
    );
    await user.click(await screen.findByRole("link", { name: "AI in medicine" }));

    form = await screen.findByRole("form", { name: "Build network" });
    expect(within(form).getByLabelText("Relationship")).toHaveValue("institution_keywords");
    expect(within(form).getByLabelText("Minimum shared keywords")).toHaveValue(5);
    expect(within(form).getByText("More options").closest("details")).toHaveAttribute("open");
  });

  it("folds after a build, keeping the settings, and Reset starts over", async () => {
    mockDataset();
    const user = renderApp("/datasets/7");

    const form = await screen.findByRole("form", { name: "Build network" });
    await user.selectOptions(within(form).getByLabelText("Relationship"), "author");
    await user.clear(within(form).getByLabelText("Maximum nodes"));
    await user.type(within(form).getByLabelText("Maximum nodes"), "400");
    await user.click(within(form).getByRole("button", { name: "Build network" }));

    expect(await screen.findByText("Queued")).toBeInTheDocument();
    expect(within(form).queryByLabelText("Maximum nodes")).toBeNull();
    await user.click(within(form).getByRole("button", { name: "Show settings" }));
    expect(within(form).getByLabelText("Maximum nodes")).toHaveValue(400);

    await user.click(within(form).getByRole("button", { name: "Reset" }));
    expect(within(form).getByLabelText("Relationship")).toHaveValue("");
    expect(within(form).queryByLabelText("Maximum nodes")).toBeNull();
  });
});

describe("records", () => {
  type Values = Record<string, string | number>;
  type Filter = { column: string; op: string; value: string };
  const DERIVED = [
    { name: "Institutions (parsed)", derived: true, type: "text" },
    { name: "Keywords (normalized)", derived: true, type: "text" },
  ];
  const COLUMNS = [
    ...profile.schema.map((c) => ({ name: c.name, derived: false, type: c.type })),
    ...DERIVED,
  ];
  // The synthetic export's six rows, with the derived columns the worker adds.
  const SYNTHETIC: Values[] = profile.sample.rows.map((row) => {
    const values: Values = {};
    profile.sample.columns.forEach((c, i) => {
      const v = row[i];
      if (v !== null && v !== undefined && v !== "") values[c] = v as string | number;
    });
    values["Institutions (parsed)"] = String(values["Addresses"]).includes("Parma")
      ? "Univ Parma; Mayo Clin"
      : "Mayo Clin";
    values["Keywords (normalized)"] = String(values["Author Keywords"]);
    return values;
  });
  const many = (n: number): Values[] =>
    Array.from({ length: n }, (_, i) => ({
      "UT (Unique WOS ID)": `WOS:${i}`,
      "Article Title": `Title ${i}`,
      "Source Title": i % 2 ? "Odd journal" : "Even journal",
    }));
  const MANY_COLUMNS = ["UT (Unique WOS ID)", "Article Title", "Source Title"].map((name) => ({
    name,
    derived: false,
    type: "text",
  }));

  const terms = (v: string) =>
    v
      .split(";")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  const matches = (f: Filter, cell: string | number | undefined) => {
    const text = cell === undefined ? "" : String(cell).toLowerCase();
    const ts = terms(f.value);
    if (f.op === "is_empty") return !text;
    if (f.op === "not_empty") return !!text;
    if (!ts.length) return true;
    if (f.op === "contains") return ts.some((t) => text.includes(t));
    if (f.op === "not_contains") return !ts.some((t) => text.includes(t));
    return text.split(";").some((item) => ts.includes(item.trim()));
  };

  /** A small stand-in for GET /datasets/:id/records (filters, sort, 50 per page). */
  function recordsApi(rows: Values[], columns = COLUMNS) {
    return (req: { path: string }) => {
      const q = new URL(req.path, "http://localhost").searchParams;
      const page = Number(q.get("page") ?? 1);
      const filters = JSON.parse(q.get("filters") ?? "[]") as Filter[];
      const known = new Set(columns.map((c) => c.name));
      const matched = rows
        .map((values, index) => ({ index, values }))
        .filter((r) =>
          filters.every((f) => !known.has(f.column) || matches(f, r.values[f.column])),
        );
      const sort = q.get("sort");
      if (sort) {
        const dir = q.get("order") === "desc" ? -1 : 1;
        const key = (r: { values: Values }) => String(r.values[sort] ?? "").toLowerCase();
        matched.sort((a, b) =>
          !key(a) ? 1 : !key(b) ? -1 : dir * key(a).localeCompare(key(b)) || a.index - b.index,
        );
      }
      const wanted = q.getAll("columns").filter((c) => known.has(c));
      const pick = (v: Values) =>
        wanted.length ? Object.fromEntries(wanted.filter((c) => c in v).map((c) => [c, v[c]])) : v;
      return {
        body: {
          status: "ready",
          error: null,
          columns,
          total: rows.length,
          matching: matched.length,
          page,
          page_size: 50,
          rows: matched.slice((page - 1) * 50, page * 50).map((r) => ({
            index: r.index,
            values: pick(r.values),
          })),
          ignored_filter_columns: [
            ...new Set(filters.map((f) => f.column).filter((c) => !known.has(c))),
          ],
        },
      };
    };
  }

  function recordsApp(path: string, rows: Values[] = SYNTHETIC, columns = COLUMNS) {
    const OTHER = { ...DATASET, id: 3, name: "Older export", created_at: "2026-10-01T10:00:00Z" };
    const api = mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
      "GET /datasets": () => ({ body: [DATASET, OTHER] }),
      "GET /datasets/7": () => ({ body: DATASET }),
      "GET /datasets/3": () => ({ body: OTHER }),
      "GET /datasets/7/profile": () => ({ body: { status: "ready", error: null, profile } }),
      "GET /datasets/7/records": recordsApi(rows, columns),
      "GET /datasets/3/records": recordsApi(rows, columns),
      "GET /runs/5": () => ({
        body: {
          id: 5,
          dataset_id: 7,
          relation: "author",
          params: {},
          status: "running",
          error: null,
          node_count: null,
          edge_count: null,
          created_at: "2026-11-12T10:00:00Z",
          started_at: null,
          finished_at: null,
        },
      }),
      ...Object.fromEntries(
        rows.map((values, index) => [
          `GET /datasets/7/records/${index}`,
          () => ({ body: { index, values } }),
        ]),
      ),
    });
    const user = renderApp(path);
    return { user, ...api };
  }

  const nav = () => screen.getByRole("navigation", { name: "Main" });
  const table = () => screen.findByRole("table");
  const headers = () =>
    screen
      .getAllByRole("columnheader")
      .map((th) => th.querySelector(".th-name")?.textContent ?? "");
  const bodyRows = () => within(screen.getAllByRole("rowgroup")[1]!).getAllByRole("row");
  const firstCells = () => bodyRows().map((r) => within(r).getAllByRole("cell")[0]!.textContent);
  const recordsCalls = (calls: { path: string }[]) =>
    calls
      .filter((c) => /^\/datasets\/\d+\/records\?/.test(c.path))
      .map((c) => new URL(c.path, "http://localhost").searchParams);
  const openFilters = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: /^Filters/ }));

  afterEach(() => localStorage.clear());

  it("shows the Records tab after Explore and follows the current dataset", async () => {
    const { user } = recordsApp("/datasets/7/data");
    await screen.findByRole("heading", { name: "Data" });
    const tabs = within(nav())
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(tabs).toEqual(["Datasets", "View data", "Explore", "Records"]);
    const records = within(nav()).getByRole("link", { name: "Records" });
    expect(records).toHaveAttribute("href", "/datasets/7/records");

    await user.click(records);
    expect(await screen.findByRole("heading", { name: "Records" })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Records" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav()).getByRole("link", { name: "View data" })).not.toHaveAttribute(
      "aria-current",
    );
    cleanupApp();

    // With an open network, the network's dataset.
    recordsApp("/runs/5");
    await screen.findByText("This network is running.");
    await vi.waitFor(() =>
      expect(within(nav()).getByRole("link", { name: "Records" })).toHaveAttribute(
        "href",
        "/datasets/7/records",
      ),
    );
    cleanupApp();

    // With no current dataset: the newest one, with the list to pick another.
    const next = recordsApp("/datasets");
    await screen.findByRole("heading", { name: "Datasets" });
    expect(within(nav()).getByRole("link", { name: "Records" })).toHaveAttribute(
      "href",
      "/records",
    );
    await next.user.click(within(nav()).getByRole("link", { name: "Records" }));
    const list = await screen.findByRole("navigation", { name: "Datasets" });
    expect(await within(list).findByRole("link", { name: /AI in medicine/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(list).getByRole("link", { name: /Older export/ })).toHaveAttribute(
      "href",
      "/datasets/3/records",
    );
  });

  it("pages through records 50 at a time and shows N of M records", async () => {
    const { user, calls } = recordsApp("/datasets/7/records", many(120), MANY_COLUMNS);
    await table();
    expect(screen.getByText("120 of 120 records")).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(50);
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.queryByRole("combobox", { name: /per page/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    await vi.waitFor(() => expect(firstCells()[0]).toBe("WOS:50"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await vi.waitFor(() => expect(bodyRows()).toHaveLength(20));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(recordsCalls(calls).map((p) => p.get("page"))).toEqual(["1", "2", "3"]);

    // N counts the matches.
    await openFilters(user);
    await user.selectOptions(screen.getByLabelText("Filter 1 column"), "Source Title");
    await user.type(screen.getByLabelText("Filter 1 value"), "odd");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("60 of 120 records")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
  });

  it("shows the default record columns that the export has", async () => {
    recordsApp("/datasets/7/records");
    await table();
    expect(headers()).toEqual([
      "UT (Unique WOS ID)",
      "Article Title",
      "Author Full Names",
      "Publication Year",
      "Document Type",
      "Source Title",
      "Author Keywords",
      "Keywords Plus",
      "Institutions (parsed)",
    ]);
    expect(headers()).not.toContain("Addresses");
    cleanupApp();

    // Without "Addresses" (so no parsed institutions) or "Keywords Plus": skipped.
    const fewer = COLUMNS.filter(
      (c) => !["Addresses", "Keywords Plus", "Institutions (parsed)"].includes(c.name),
    );
    recordsApp("/datasets/7/records", SYNTHETIC, fewer);
    await table();
    expect(headers()).toEqual([
      "UT (Unique WOS ID)",
      "Article Title",
      "Author Full Names",
      "Publication Year",
      "Document Type",
      "Source Title",
      "Author Keywords",
    ]);
  });

  it("cuts long record cells to one line", async () => {
    const title = "A very long article title ".repeat(20).trim();
    const rows = [{ "UT (Unique WOS ID)": "WOS:1", "Article Title": title }];
    recordsApp("/datasets/7/records", rows, MANY_COLUMNS);
    const t = await table();
    const cell = within(t).getByTitle(title);
    expect(cell).toHaveClass("cell-clip");
    expect(cell).toHaveTextContent(title); // all of it, cut by CSS
    expect(t).toHaveClass("records-table");
    // The rules that make it one line with "…", and keep the table within the page.
    const css = readFileSync(`${process.cwd()}/src/styles.css`, "utf8").replace(/\s+/g, " ");
    expect(css).toMatch(/\.cell-clip \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
    expect(css).toMatch(/\.cell-clip \{[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.records-table \{[^}]*table-layout: fixed;/);
    expect(css).toMatch(/\.records-scroll \{[^}]*overflow-x: hidden;/);
  });

  it("opens a record with all its fields and returns to the same page", async () => {
    const path = `/datasets/7/records?f=${encodeURIComponent('["Author Keywords","contains","deep"]')}`;
    const { user } = recordsApp(path);
    await table();
    expect(screen.getByText("3 of 6 records")).toBeInTheDocument();
    const row = bodyRows()[0]!;
    await user.click(row);

    const dialog = await screen.findByRole("dialog", { name: "Synthetic article WOS:1" });
    const fields = [...dialog.querySelectorAll("dt")].map((dt) =>
      dt.textContent?.replace(/\*.*$/, ""),
    );
    expect(fields).toEqual(COLUMNS.map((c) => c.name)); // every column, derived ones too
    const field = (name: string) =>
      [...dialog.querySelectorAll("dt")].find((dt) => dt.textContent?.startsWith(name))!
        .nextElementSibling!;
    expect(field("Keywords Plus")).toHaveTextContent("(empty)");
    expect(field("Addresses")).toHaveTextContent("Univ Parma, Dept Med");
    expect(field("Institutions (parsed)")).toHaveTextContent("Univ Parma; Mayo Clin");

    // Modal: the page behind is inert and Tab stays in the dialog.
    expect(screen.getByRole("table").closest("[inert]")).not.toBeNull();
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();

    await user.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("table").closest("[inert]")).toBeNull();
    expect(screen.getByText("3 of 6 records")).toBeInTheDocument(); // same filters
    expect(bodyRows()[0]).toHaveFocus(); // back where it was
    await user.keyboard("{Enter}");
    const again = await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(again).not.toBeInTheDocument();
  });

  it("shows the records empty state while the profile is pending or failed", async () => {
    const backend = (status: string, error: string | null) =>
      mockApi({
        "GET /auth/me": () => ({ body: SESSION }),
        "GET /datasets": () => ({ body: [DATASET] }),
        "GET /datasets/7": () => ({ body: DATASET }),
        "GET /datasets/7/records": () => ({
          body: {
            status,
            error,
            columns: [],
            total: 0,
            matching: 0,
            page: 1,
            page_size: 50,
            rows: [],
            ignored_filter_columns: [],
          },
        }),
      });
    backend("pending", null);
    renderApp("/datasets/7/records");
    expect(await screen.findByText(/this takes a few seconds after upload/)).toBeInTheDocument();
    expect(screen.getByText("Analysing")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    cleanupApp();

    backend("failed", "Could not read WoS_1.xls");
    renderApp("/datasets/7/records");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The files could not be analysed: Could not read WoS_1.xls",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows and hides record columns with the column picker", async () => {
    const { user, calls } = recordsApp("/datasets/7/records");
    await table();
    await user.click(screen.getByRole("button", { name: /^Columns/ }));
    const picker = screen.getByRole("group", { name: "Columns" });
    const boxes = within(picker).getAllByRole("checkbox");
    expect(boxes).toHaveLength(COLUMNS.length); // every column of the export + derived

    await user.click(within(picker).getByRole("checkbox", { name: "Article Title" }));
    expect(headers()).not.toContain("Article Title");
    await user.click(within(picker).getByRole("checkbox", { name: "Addresses" }));
    expect(headers()).toContain("Addresses");
    await vi.waitFor(() =>
      expect(recordsCalls(calls).at(-1)?.getAll("columns")).toContain("Addresses"),
    );

    // Hide all but one: the last visible column can't be hidden.
    for (const name of headers().slice(1)) {
      await user.click(
        within(picker).getByRole("checkbox", {
          name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`),
        }),
      );
    }
    expect(headers()).toEqual(["UT (Unique WOS ID)"]);
    expect(within(picker).getByRole("checkbox", { name: "UT (Unique WOS ID)" })).toBeDisabled();
  });

  it("remembers the record columns per dataset", async () => {
    const { user } = recordsApp("/datasets/7/records");
    await table();
    await user.click(screen.getByRole("button", { name: /^Columns/ }));
    const picker = () => screen.getByRole("group", { name: "Columns" });
    await user.click(within(picker()).getByRole("checkbox", { name: "Article Title" }));
    await user.click(within(picker()).getByRole("checkbox", { name: "Addresses" }));
    const chosen = headers();
    cleanupApp();

    // Coming back (a reload) shows the same columns.
    recordsApp("/datasets/7/records");
    await table();
    expect(headers()).toEqual(chosen);
    cleanupApp();

    // Another dataset keeps its own (here, the default) choice.
    recordsApp("/datasets/3/records");
    await table();
    expect(headers()).toContain("Article Title");
    expect(headers()).not.toContain("Addresses");
    cleanupApp();

    const back = recordsApp("/datasets/7/records");
    await table();
    await back.user.click(screen.getByRole("button", { name: /^Columns/ }));
    await back.user.click(screen.getByRole("button", { name: "Reset columns" }));
    expect(headers()).toContain("Article Title");
    expect(headers()).not.toContain("Addresses");
  });

  it("sorts records by a column header", async () => {
    const rows: Values[] = [
      { "UT (Unique WOS ID)": "WOS:1", "Article Title": "beta" },
      { "UT (Unique WOS ID)": "WOS:2" },
      { "UT (Unique WOS ID)": "WOS:3", "Article Title": "Alpha" },
    ];
    const { user, calls } = recordsApp("/datasets/7/records", rows, MANY_COLUMNS);
    await table();
    const header = () => screen.getByRole("columnheader", { name: /Article Title/ });
    const sortButton = () => within(header()).getByRole("button");

    await user.click(sortButton());
    await vi.waitFor(() => expect(firstCells()).toEqual(["WOS:3", "WOS:1", "WOS:2"]));
    expect(header()).toHaveAttribute("aria-sort", "ascending");
    await user.click(sortButton());
    await vi.waitFor(() => expect(firstCells()).toEqual(["WOS:1", "WOS:3", "WOS:2"]));
    expect(header()).toHaveAttribute("aria-sort", "descending");
    await user.click(sortButton());
    await vi.waitFor(() => expect(firstCells()).toEqual(["WOS:1", "WOS:2", "WOS:3"]));
    expect(header()).not.toHaveAttribute("aria-sort");

    // The server sorts (all matching records, not just this page).
    expect(recordsCalls(calls).map((p) => [p.get("sort"), p.get("order")])).toEqual([
      [null, null],
      ["Article Title", "asc"],
      ["Article Title", "desc"],
      [null, null],
    ]);
  });

  it("filters records only on Apply and clears them", async () => {
    const { user, calls } = recordsApp("/datasets/7/records");
    await table();
    await openFilters(user);
    const column = screen.getByLabelText("Filter 1 column");
    // Any column, visible or not.
    expect(within(column).getAllByRole("option")).toHaveLength(COLUMNS.length);
    expect(
      within(screen.getByLabelText("Filter 1 operator"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["contains", "does not contain", "has item", "is empty", "is not empty"]);

    await user.selectOptions(column, "Addresses");
    await user.type(screen.getByLabelText("Filter 1 value"), "fudan");
    expect(screen.getByText("6 of 6 records")).toBeInTheDocument(); // not yet
    expect(recordsCalls(calls).every((p) => !p.has("filters"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("2 of 6 records")).toBeInTheDocument();
    expect(JSON.parse(recordsCalls(calls).at(-1)!.get("filters")!)).toEqual([
      { column: "Addresses", op: "contains", value: "fudan" },
    ]);

    // "is empty" / "is not empty" take no value.
    await user.click(screen.getByRole("button", { name: "+ Add filter" }));
    await user.selectOptions(screen.getByLabelText("Filter 2 operator"), "not_empty");
    expect(screen.getByLabelText("Filter 2 value")).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Filter 2 column"), "ORCIDs");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("1 of 6 records")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("6 of 6 records")).toBeInTheDocument();
    expect(recordsCalls(calls).at(-1)!.has("filters")).toBe(false);
  });

  it("says when no records match the filters", async () => {
    const { user } = recordsApp("/datasets/7/records");
    await table();
    await openFilters(user);
    await user.type(screen.getByLabelText("Filter 1 value"), "no such record");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("No records match these filters.")).toBeInTheDocument();
    expect(screen.getByText("0 of 6 records")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("highlights the matched text in record cells", async () => {
    const f = (column: string, op: string, value: string) =>
      `f=${encodeURIComponent(JSON.stringify([column, op, value]))}`;
    const { user } = recordsApp(
      `/datasets/7/records?${f("Article Title", "contains", "WOS:1")}&${f("Author Keywords", "has_item", "Deep learning; oncology")}`,
    );
    const t = await table();
    const marks = [...t.querySelectorAll("mark")].map((m) => m.textContent);
    expect(marks).toEqual(["WOS:1", "deep learning"]); // "oncology" is no whole item
    const cell = within(t).getByTitle(/^fetal ultrasound; deep learning/);
    expect(cell.querySelector("mark")).toHaveTextContent("deep learning");

    await user.click(bodyRows()[0]!);
    const dialog = await screen.findByRole("dialog");
    expect([...dialog.querySelectorAll("mark")].map((m) => m.textContent)).toEqual([
      "WOS:1",
      "deep learning",
    ]);
  });

  it("restores record filters, sort and page from the URL", async () => {
    const filter = encodeURIComponent('["Source Title","contains","odd"]');
    const unknown = encodeURIComponent('["Nope","contains","x"]');
    const { calls } = recordsApp(
      `/datasets/7/records?f=${filter}&f=${unknown}&sort=Article%20Title&order=desc&page=2`,
      many(120),
      MANY_COLUMNS,
    );
    await table();
    expect(screen.getByText("60 of 120 records")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Article Title/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    const sent = recordsCalls(calls)[0]!;
    expect(sent.get("page")).toBe("2");
    expect(sent.get("sort")).toBe("Article Title");
    expect(sent.get("order")).toBe("desc");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ignored a filter on an unknown column: Nope.",
    );
    // The known filter is in the editor; the unknown one was dropped.
    expect(screen.getByRole("button", { name: "Filters (1)" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByLabelText("Filter 1 column")).toHaveValue("Source Title");
    expect(screen.getByLabelText("Filter 1 value")).toHaveValue("odd");
    expect(screen.queryByLabelText("Filter 2 column")).toBeNull();
  });

  it("marks derived record columns and shows only Institutions (parsed) by default", async () => {
    const { user } = recordsApp("/datasets/7/records");
    await table();
    expect(
      screen.getByRole("columnheader", {
        name: /^Institutions \(parsed\)\s*\(derived, not in the export\)$/,
      }),
    ).toBeInTheDocument();
    expect(headers()).not.toContain("Keywords (normalized)");
    expect(screen.getByText(/derived, not in the export: computed/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Columns/ }));
    const picker = screen.getByRole("group", { name: "Columns" });
    const box = (name: RegExp) => within(picker).getByRole("checkbox", { name });
    expect(box(/^Institutions \(parsed\)\s*\(derived, not in the export\)$/)).toBeChecked();
    expect(box(/^Keywords \(normalized\)\s*\(derived, not in the export\)$/)).not.toBeChecked();
    expect(box(/^Addresses$/)).not.toBeChecked();
  });

  it("notes that records opened from a link may differ from the link", async () => {
    const note = /keeps at most 20 shared items per link/;
    const f = encodeURIComponent('["Institutions (parsed)","contains","Univ Parma; Mayo Clin"]');
    recordsApp(`/datasets/7/records?f=${f}&from=link`);
    await table();
    expect(
      screen.getByText(
        "The network file keeps at most 20 shared items per link and skips keywords used in too many articles, so these records may differ from the link.",
      ),
    ).toBeInTheDocument();
    cleanupApp();

    recordsApp(`/datasets/7/records?f=${f}&from=node`);
    await table();
    expect(screen.queryByText(note)).toBeNull();
    cleanupApp();

    // Once the user applies filters of their own, the note no longer applies.
    const fromLink = recordsApp(`/datasets/7/records?f=${f}&from=link`);
    await table();
    expect(screen.getByText(note)).toBeInTheDocument();
    await fromLink.user.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => expect(screen.queryByText(note)).toBeNull());
    cleanupApp();

    recordsApp("/datasets/7/records");
    await table();
    expect(screen.queryByText(note)).toBeNull();
  });

  it("shows the filtered columns when opened from the explorer", async () => {
    const f = (column: string, value: string) =>
      `f=${encodeURIComponent(JSON.stringify([column, "contains", value]))}`;
    // "Keywords (normalized)" and "Addresses" are hidden by default.
    const path = `/datasets/7/records?${f("Institutions (parsed)", "Univ Parma; Mayo Clin")}&${f("Keywords (normalized)", "deep learning")}`;
    recordsApp(`${path}&from=link`);
    await table();
    expect(headers()).toContain("Institutions (parsed)");
    expect(headers()).toContain("Keywords (normalized)");
    cleanupApp();

    recordsApp(`/datasets/7/records?${f("Addresses", "Parma")}&from=node`);
    await table();
    expect(headers()).toContain("Addresses");
    cleanupApp();

    // Not when the same view is opened directly.
    recordsApp(path);
    await table();
    expect(headers()).not.toContain("Keywords (normalized)");
  });
});
