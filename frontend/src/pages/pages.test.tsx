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
    await user.click(within(form).getByText("More options"));
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

  it("shows the data page from a real pipeline profile", async () => {
    mockApi({
      "GET /auth/me": () => ({ body: SESSION }),
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
