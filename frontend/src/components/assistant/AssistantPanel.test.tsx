// The assistant's chat panel in the whole app (router + React Query) against a
// fake backend. The chat endpoint is a stand-in: no test talks to Anthropic.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { App } from "../../App";
import { clearFormState } from "../../lib/buildFormState";
import { forgetNetwork } from "../../lib/lastNetwork";
import { DATASET, OPTIONS, PROPOSAL, answer, ask, holdChat } from "../../test/assistant";
import { SESSION, mockApi, type Recorded } from "../../test/mockApi";

// Cytoscape needs a canvas jsdom doesn't have (see Explorer.test.tsx).
vi.mock("../explorer/GraphView", () => ({ GraphView: () => <div data-testid="graph" /> }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearFormState();
  forgetNetwork();
});

type Handler = Parameters<typeof mockApi>[0][string];

/** The logged-in app with the assistant on; `chat` answers POST /assistant/chat. */
function backend(chat: Handler, extra: Record<string, Handler> = {}) {
  return mockApi({
    "GET /auth/me": () => ({ body: SESSION }),
    "GET /assistant/status": () => ({ body: { enabled: true } }),
    "POST /assistant/chat": chat,
    "GET /datasets": () => ({ body: [DATASET] }),
    "GET /datasets/7": () => ({ body: DATASET }),
    "GET /runs?dataset_id=7": () => ({ body: [] }),
    "GET /datasets/7/network-options": () => ({ body: OPTIONS }),
    ...extra,
  });
}

const panel = () => screen.getByRole("complementary", { name: "Assistant" });
const conversation = () => within(panel()).getByRole("log", { name: "Conversation" });

describe("assistant panel", () => {
  it("opens the chat panel from the top bar without leaving the page", async () => {
    backend(() => ({ body: answer("Hi") }));
    const user = renderApp("/datasets/7");
    expect(await screen.findByRole("heading", { name: "AI in medicine" })).toBeInTheDocument();

    const button = await screen.findByRole("button", { name: "Assistant" });
    expect(button.closest("header")).not.toBeNull(); // in the top bar
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");

    expect(within(panel()).getByLabelText("Message")).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "New conversation" })).toBeInTheDocument();
    // Beside the page: the dataset page is still there.
    expect(screen.getByRole("heading", { name: "AI in medicine" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Build network" })).toBeInTheDocument();

    await user.click(within(panel()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull();
    expect(screen.getByRole("heading", { name: "AI in medicine" })).toBeInTheDocument();
  });

  it("shows the question, a waiting state, then the answer", async () => {
    const api = backend(() => ({
      body: answer("A model decides when two articles match on the link field."),
    }));
    const { release } = holdChat(api);
    const user = renderApp("/datasets");
    await user.click(await screen.findByRole("button", { name: "Assistant" }));
    const send = within(panel()).getByRole("button", { name: "Send" });
    expect(send).toBeDisabled(); // empty message box
    await user.type(within(panel()).getByLabelText("Message"), "   ");
    expect(send).toBeDisabled();

    await user.clear(within(panel()).getByLabelText("Message"));
    await user.type(within(panel()).getByLabelText("Message"), "What does a link model mean?");
    expect(send).toBeEnabled();
    await user.click(send);

    expect(within(conversation()).getByText("What does a link model mean?")).toBeInTheDocument();
    expect(within(conversation()).getByRole("status")).toHaveTextContent("Thinking…");
    expect(within(panel()).getByLabelText("Message")).toHaveValue("");
    await user.type(within(panel()).getByLabelText("Message"), "And thresholds?");
    expect(send).toBeDisabled(); // while waiting

    release();
    expect(
      await within(conversation()).findByText(
        "A model decides when two articles match on the link field.",
      ),
    ).toBeInTheDocument();
    expect(within(conversation()).queryByText("Thinking…")).toBeNull();
    expect(send).toBeEnabled();
  });

  it("shows answers as plain text, never as HTML", async () => {
    const html = '<img src=x onerror="window.pwned=1"><b>bold</b><script>window.pwned=2</script>';
    backend(() => ({ body: answer(`Line one\n${html}`) }));
    const user = renderApp("/datasets");
    await ask(user, "Show me HTML");

    const text = await within(conversation()).findByText(/Line one/);
    expect(text.textContent).toBe(`Line one\n${html}`);
    expect(text.querySelector("img, b, script")).toBeNull();
    expect(conversation().querySelector("img, b, script")).toBeNull();
    expect((window as { pwned?: number }).pwned).toBeUndefined();
  });

  it("keeps the conversation across pages and clears it on New conversation and logout", async () => {
    let loggedIn = true;
    let n = 0;
    backend(() => ({ body: answer(`Answer ${++n}`) }), {
      "GET /auth/me": () =>
        loggedIn ? { body: SESSION } : { status: 401, body: { detail: "Not authenticated" } },
      "POST /auth/logout": () => {
        loggedIn = false;
        return { status: 204 };
      },
      "POST /auth/login": () => {
        loggedIn = true;
        return { body: SESSION };
      },
    });
    const user = renderApp("/datasets/7");
    await ask(user, "First question");
    expect(await within(conversation()).findByText("Answer 1")).toBeInTheDocument();

    // Another page: still there; closing and reopening keeps it too.
    await user.click(screen.getByRole("link", { name: "← Datasets" }));
    expect(await screen.findByRole("heading", { name: "Datasets" })).toBeInTheDocument();
    expect(within(conversation()).getByText("First question")).toBeInTheDocument();
    await user.click(within(panel()).getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Assistant" }));
    expect(within(conversation()).getByText("Answer 1")).toBeInTheDocument();

    // New conversation empties it.
    await user.click(within(panel()).getByRole("button", { name: "New conversation" }));
    expect(within(conversation()).queryByText("First question")).toBeNull();
    expect(within(conversation()).queryByText("Answer 1")).toBeNull();

    await ask(user, "Second question");
    expect(await within(conversation()).findByText("Answer 2")).toBeInTheDocument();

    // Logging out empties it as well, even after logging in again in the same tab.
    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "ann@example.org");
    await user.type(screen.getByLabelText("Password"), "right-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await user.click(await screen.findByRole("button", { name: "Assistant" }));
    expect(within(conversation()).queryByText("Second question")).toBeNull();
    expect(within(conversation()).queryByText("Answer 2")).toBeNull();
  });

  it("offers to open the build form with a proposal", async () => {
    const api = backend(() => ({ body: answer("Try this.", { proposal: PROPOSAL }) }));
    const user = renderApp("/datasets");
    await ask(user, "Countries that share keywords");

    const reply = (await within(conversation()).findByText("Try this.")).parentElement!;
    expect(within(reply).getByText(PROPOSAL.summary)).toBeInTheDocument();
    // Nothing happens to the page until the button is used.
    expect(screen.getByRole("heading", { name: "Datasets" })).toBeInTheDocument();
    await user.click(within(reply).getByRole("button", { name: "Open in Build form" }));

    const form = await screen.findByRole("form", { name: "Build network" });
    expect(within(form).getByRole("status")).toHaveTextContent(
      "Suggested by the assistant. Check the settings and click Build.",
    );
    expect(within(form).getByLabelText("Relationship")).toHaveValue("custom");
    const nodes = await within(form).findByLabelText("Nodes");
    expect(nodes).toHaveValue("country");
    expect(nodes).toHaveClass("suggested");
    expect(within(form).getByLabelText("Maximum nodes")).toHaveValue(150);
    expect(within(form).getByLabelText("Minimum shared items")).toHaveValue(4);
    expect(within(form).getByLabelText("Ignore items used by more than (%)")).toHaveValue(10);
    expect(within(form).getByLabelText("Minimum link weight")).toHaveValue(2);
    expect(within(reply).getByText("Filled in the Build network form.")).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/runs")).toBe(false);
  });

  it("sends only the conversation and the open dataset or network id", async () => {
    const run = {
      id: 5,
      dataset_id: 7,
      relation: "custom",
      params: { entity: "institution", link: "keywords" },
      status: "succeeded",
      error: null,
      node_count: 2,
      edge_count: 1,
      created_at: "2026-11-12T10:00:00Z",
      started_at: null,
      finished_at: null,
    };
    const network = {
      nodes: [
        { id: "a", name: "Secret Univ Alpha", team: "Narnia", role: "1 linked", attr: {} },
        { id: "b", name: "Secret Univ Beta", team: "Narnia", role: "1 linked" },
      ],
      edges: [{ source: "a", target: "b", type: "shares_keywords_with", weight: 3 }],
    };
    const api = backend(() => ({ body: answer("OK") }), {
      "GET /runs/5": () => ({ body: run }),
      "GET /runs/5/network": () => ({ body: network }),
      "GET /datasets/7/profile": () => ({
        body: { status: "pending", error: null, profile: null },
      }),
    });
    const user = renderApp("/datasets/7/data");
    await ask(user, "What is here?");
    await within(conversation()).findByText("OK");

    // A network: its id (and its dataset's), never its content.
    cleanup();
    vi.unstubAllGlobals();
    const api2 = backend(() => ({ body: answer("Fine") }), {
      "GET /runs/5": () => ({ body: run }),
      "GET /runs/5/network": () => ({ body: network }),
    });
    const user2 = renderApp("/runs/5");
    await screen.findByRole("heading", { name: /Custom network|linked by/ });
    await user2.type(screen.getByRole("searchbox", { name: "Find by node name" }), "secret");
    await ask(user2, "Only the strong links");
    await within(conversation()).findByText("Fine");

    const sent = (calls: Recorded[]) =>
      calls.filter((c) => c.path === "/assistant/chat").map((c) => c.body);
    expect(sent(api.calls)).toEqual([
      {
        messages: [{ role: "user", text: "What is here?" }],
        context: { page: "data", dataset_id: 7, run_id: null },
      },
    ]);
    expect(sent(api2.calls)).toEqual([
      {
        messages: [{ role: "user", text: "Only the strong links" }],
        context: { page: "explorer", dataset_id: 7, run_id: 5 },
      },
    ]);
    const body = JSON.stringify(sent(api2.calls));
    for (const secret of ["Secret Univ", "Narnia", "secret", "shares_keywords_with"]) {
      expect(body).not.toContain(secret);
    }
    const headers = api2.calls.find((c) => c.path === "/assistant/chat")!.headers;
    expect(headers.get("X-CSRF-Token")).not.toBeNull();
  });

  it("applies actions only to the network the question was about", async () => {
    const run = (id: number) => ({
      id,
      dataset_id: 7,
      relation: "custom",
      params: { entity: "institution", link: "keywords" },
      status: "succeeded",
      error: null,
      node_count: 3,
      edge_count: 1,
      created_at: `2026-11-1${id}T10:00:00Z`,
      started_at: null,
      finished_at: null,
    });
    const network = {
      nodes: [
        { id: "a", name: "A", team: "Italy", role: "x" },
        { id: "b", name: "B", team: "Italy", role: "x" },
        { id: "c", name: "C", team: "USA", role: "x" },
      ],
      edges: [{ source: "a", target: "b", type: "shares_keywords_with", weight: 1 }],
    };
    const api = backend(
      () => ({ body: answer("Done.", { actions: [{ kind: "keep_largest_groups", n: 1 }] }) }),
      {
        "GET /runs?dataset_id=7": () => ({ body: [run(5), run(6)] }),
        "GET /runs/5": () => ({ body: run(5) }),
        "GET /runs/6": () => ({ body: run(6) }),
        "GET /runs/5/network": () => ({ body: network }),
        "GET /runs/6/network": () => ({ body: network }),
      },
    );
    const { release } = holdChat(api);
    const user = renderApp("/runs/5");
    await screen.findByRole("heading", { name: /linked by/ });
    await ask(user, "Only the largest group");

    // While waiting, the user opens another network of the dataset.
    await user.click(screen.getByRole("link", { name: /AI in medicine/ }));
    const explore = await screen.findAllByRole("link", { name: "Explore" });
    await user.click(explore.find((a) => a.getAttribute("href") === "/runs/6")!);
    await screen.findByRole("heading", { name: /linked by/ });
    const usa = () => screen.getByRole("checkbox", { name: /USA/ });
    expect(usa()).toBeChecked();

    release();
    expect(
      await within(conversation()).findByText(
        "Open the network in the explorer to apply these changes.",
      ),
    ).toBeInTheDocument();
    expect(usa()).toBeChecked(); // run 6 untouched
    const sent = api.calls.filter((c) => c.path === "/assistant/chat");
    expect((sent[0]!.body as { context: { run_id: number } }).context.run_id).toBe(5);

    // Asked about run 6 while it is open: applied.
    await ask(user, "Only the largest group");
    expect(
      await within(conversation()).findByText("Showing the largest group"),
    ).toBeInTheDocument();
    expect(usa()).not.toBeChecked();
  });

  it("tells the server a local file is open on the local explorer", async () => {
    const api = backend(() => ({ body: answer("Use the filters by hand.") }));
    const user = renderApp("/local");
    await ask(user, "Only the largest group");
    await within(conversation()).findByText("Use the filters by hand.");
    const sent = api.calls.filter((c) => c.path === "/assistant/chat").map((c) => c.body);
    expect(sent).toEqual([
      {
        messages: [{ role: "user", text: "Only the largest group" }],
        context: { page: "local", dataset_id: null, run_id: null },
      },
    ]);
  });

  it("says what is sent to Anthropic", async () => {
    backend(() => ({ body: answer("OK") }));
    const user = renderApp("/datasets");
    await user.click(await screen.findByRole("button", { name: "Assistant" }));
    const note = within(panel()).getByText(
      "Your messages are sent to Anthropic's Claude. Names and values from your data are not, unless you type them.",
    );
    const box = within(panel()).getByLabelText("Message");
    expect(note.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the Assistant button when the assistant is off", async () => {
    // Off on the server, and an older server without the endpoint (404).
    for (const status of [{ body: { enabled: false } }, { status: 404, body: {} }]) {
      backend(() => ({ body: answer("never") }), { "GET /assistant/status": () => status });
      const user = renderApp("/datasets/7");
      const form = await screen.findByRole("form", { name: "Build network" });
      await waitFor(() => expect(screen.getByText("ann@example.org")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Assistant" })).toBeNull();
      // Everything else works as before.
      await user.selectOptions(within(form).getByLabelText("Relationship"), "custom");
      expect(await within(form).findByLabelText("Nodes")).toHaveValue("institution");
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("shows assistant errors as a friendly message", async () => {
    const replies = [
      {
        status: 429,
        body: {
          detail: "You've asked a lot of questions. Please wait a few minutes and try again.",
        },
      },
      {
        status: 502,
        body: { detail: "The assistant is not available right now. Please try again later." },
      },
      { status: 500, body: { detail: "Traceback (most recent call last): KeyError" } },
      { body: answer("Back again") },
    ];
    const api = backend(() => replies.shift());
    const user = renderApp("/datasets");

    await ask(user, "One");
    expect(await within(conversation()).findByRole("alert")).toHaveTextContent(
      "You've asked a lot of questions. Please wait a few minutes and try again.",
    );
    await ask(user, "Two");
    await waitFor(() => expect(within(conversation()).getAllByRole("alert")).toHaveLength(2));
    expect(within(conversation()).getAllByRole("alert")[1]).toHaveTextContent(
      "The assistant is not available right now. Please try again later.",
    );
    await ask(user, "Three");
    await waitFor(() => expect(within(conversation()).getAllByRole("alert")).toHaveLength(3));
    expect(within(conversation()).getAllByRole("alert")[2]).toHaveTextContent(
      "The assistant is not available right now. Please try again later.",
    );
    expect(conversation()).not.toHaveTextContent("Traceback");

    // Questions that failed stay visible but aren't sent again.
    await ask(user, "Four");
    expect(await within(conversation()).findByText("Back again")).toBeInTheDocument();
    const last = api.calls.filter((c) => c.path === "/assistant/chat").at(-1)!;
    expect((last.body as { messages: unknown[] }).messages).toEqual([
      { role: "user", text: "Four" },
    ]);
  });
});
