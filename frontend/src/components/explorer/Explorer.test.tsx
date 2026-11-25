// Explorer behavior through real user interaction (DOM events via user-event).
// Cytoscape needs a canvas jsdom doesn't have, so GraphView is replaced by a
// probe that exposes what the Explorer asked the graph to show.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ExplorerAction } from "../../api/client";
import type { RecordsSource } from "../../lib/records";
import { answer, ask } from "../../test/assistant";
import { sampleNetwork } from "../../test/fixtures";
import { mockApi } from "../../test/mockApi";
import { AssistantProvider } from "../assistant/AssistantContext";
import { AssistantButton, AssistantPanel } from "../assistant/AssistantPanel";
import { Explorer } from "./Explorer";

vi.mock("./GraphView", () => ({
  GraphView: (p: {
    visibleNodeIds: Set<string>;
    visibleEdgeIdx: Set<number>;
    search: string;
    onSelect: (s: unknown) => void;
    fitRequest?: number;
  }) => (
    <div
      data-testid="graph"
      data-nodes={[...p.visibleNodeIds].sort().join(",")}
      data-edges={[...p.visibleEdgeIdx].sort().join(",")}
      data-search={p.search}
      data-fit={p.fitRequest ?? 0}
    >
      <button type="button" onClick={() => p.onSelect({ kind: "edge", index: 0 })}>
        tap edge 0
      </button>
      <button type="button" onClick={() => p.onSelect({ kind: "node", id: "a" })}>
        tap node a
      </button>
    </div>
  ),
}));

beforeAll(() => {
  // jsdom lacks these browser APIs used for layout.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

function setup(network = sampleNetwork()) {
  const user = userEvent.setup();
  render(<Explorer network={network} title="Test network" />);
  const filters = screen.getByRole("complementary", { name: "Filters" });
  const details = screen.getByRole("complementary", { name: "Details" });
  return { user, filters, details };
}

const graph = () => screen.getByTestId("graph");
const jsonText = (details: HTMLElement) => details.querySelector(".json-view")?.textContent ?? "";
/** Ids of the nodes listed in the JSON view. */
const jsonNodeIds = (details: HTMLElement) =>
  [...details.querySelectorAll<HTMLElement>(".json-item")]
    .map((el) => el.dataset.key!)
    .filter((k) => !/^e\d+$/.test(k));

describe("Explorer", () => {
  it("shows the back link above the title and the footer below the graph", () => {
    render(
      <Explorer
        network={sampleNetwork()}
        title="Test network"
        back={<a href="/datasets/7">← AI in medicine</a>}
        footer={<a href="/export">Download JSON</a>}
      />,
    );
    const heading = screen.getByRole("heading", { name: "Test network" });
    const back = screen.getByRole("link", { name: "← AI in medicine" });
    const download = screen.getByRole("link", { name: "Download JSON" });
    const after = (a: Node, b: Node) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(back, heading)).toBe(true);
    expect(after(graph(), download)).toBe(true);
  });

  it("starts with everything visible", () => {
    const { details } = setup();
    expect(screen.getByText("5 of 5 nodes · 4 of 4 links shown")).toBeInTheDocument();
    expect(graph().dataset.nodes).toBe("a,b,c,d,z");
    expect(jsonNodeIds(details)).toHaveLength(5);
  });

  it("Group checkbox hides nodes everywhere (graph, count, JSON)", async () => {
    const { user, filters, details } = setup();
    await user.click(within(filters).getByRole("checkbox", { name: /USA/ }));

    expect(graph().dataset.nodes).toBe("a,b,d");
    expect(graph().dataset.edges).toBe("0");
    expect(screen.getByText("3 of 5 nodes · 1 of 4 links shown")).toBeInTheDocument();
    expect(jsonNodeIds(details)).toEqual(["a", "b", "d"]);

    const json = jsonText(details);
    expect(json).toContain('"id": "a"');
    expect(json).not.toContain('"id": "c"');
    expect(json.match(/"source"/g)).toHaveLength(1);
  });

  it("'Hide all' / 'Show all' toggles every group", async () => {
    const { user, filters } = setup();
    await user.click(within(filters).getByRole("button", { name: "Hide all" }));
    expect(graph().dataset.nodes).toBe("");
    await user.click(within(filters).getByRole("button", { name: "Show all" }));
    expect(graph().dataset.nodes).toBe("a,b,c,d,z");
  });

  it("name search highlights only, never hides", async () => {
    const { user, filters, details } = setup();
    await user.type(within(filters).getByRole("searchbox", { name: "Find by node name" }), "ROSSI");
    expect(graph().dataset.search).toBe("rossi");
    expect(screen.getByText("1 match highlighted")).toBeInTheDocument();
    expect(graph().dataset.nodes).toBe("a,b,c,d,z");
    expect(jsonNodeIds(details)).toHaveLength(5);
  });

  it("attribute search filters only on Apply; OR within a row, AND across rows", async () => {
    const { user, filters } = setup();
    await user.click(within(filters).getByText("Attribute search"));

    const nodes = within(filters).getByRole("group", { name: "Nodes" });
    await user.selectOptions(
      within(nodes).getByRole("combobox", { name: /attribute 1/ }),
      "institution",
    );
    await user.type(
      within(nodes).getByRole("combobox", { name: /institution contains/ }),
      "parma; mayo",
    );
    expect(graph().dataset.nodes).toBe("a,b,c,d,z"); // typed, not applied

    await user.click(within(nodes).getByRole("button", { name: "Apply" }));
    expect(graph().dataset.nodes).toBe("a,b,c,z");

    await user.click(within(nodes).getByRole("button", { name: "+ Add condition" }));
    await user.selectOptions(
      within(nodes).getByRole("combobox", { name: /attribute 2/ }),
      "author_keywords",
    );
    await user.type(
      within(nodes).getByRole("combobox", { name: /author_keywords contains/ }),
      "fetal",
    );
    await user.click(within(nodes).getByRole("button", { name: "Apply" }));
    expect(graph().dataset.nodes).toBe("a");
    expect(within(nodes).getByRole("status")).toHaveTextContent("2 applied");

    await user.click(within(nodes).getByRole("button", { name: "Clear" }));
    expect(graph().dataset.nodes).toBe("a,b,c,d,z");
  });

  it("edge attribute search drops nodes left without visible links (isolated nodes stay)", async () => {
    const { user, filters } = setup();
    await user.click(within(filters).getByText("Attribute search"));
    const links = within(filters).getByRole("group", { name: "Links" });
    await user.selectOptions(
      within(links).getByRole("combobox", { name: /attribute 1/ }),
      "article_titles",
    );
    await user.type(
      within(links).getByRole("combobox", { name: /article_titles contains/ }),
      "fetal{Enter}",
    );
    expect(graph().dataset.edges).toBe("0");
    expect(graph().dataset.nodes).toBe("a,b,z");
  });

  it("the right panel shows only the JSON, no Readable list", () => {
    const { details } = setup();
    expect(within(details).getByRole("heading", { name: "JSON" })).toBeInTheDocument();
    expect(within(details).queryByRole("tab")).toBeNull();
    expect(within(details).queryByText(/Readable/)).toBeNull();
  });

  it("tapping a link in the graph shows the link and marks it in the JSON", async () => {
    const { user, details } = setup();
    const selection = within(details).getByRole("region", { name: "Selection" });
    await user.click(screen.getByRole("button", { name: "tap edge 0" }));
    expect(within(selection).getByRole("heading")).toHaveTextContent(
      "Rossi, Anna — Bianchi, Marco",
    );
    expect(within(selection).getByText("Fetal imaging with AI")).toBeInTheDocument();
    expect(details.querySelector('[data-key="e0"]')).toHaveClass("selected");
  });

  it("filter list doubles as the legend: largest groups first, other/unknown last", () => {
    const { filters } = setup();
    const groups = within(filters).getByRole("group", { name: /Group/ });
    const labels = within(groups)
      .getAllByRole("checkbox")
      .map((c) => c.closest("label")!.textContent);
    expect(labels).toEqual(["Italy2", "USA2", "Other1"]);
  });

  it("link weight range hides links by weight; the checkbox hides nodes left unlinked", async () => {
    const { user, filters, details } = setup();
    const low = within(filters).getByLabelText("Lowest link weight shown");
    expect(within(filters).getByText(/4 of 4 links/)).toBeInTheDocument();

    fireEvent.change(low, { target: { value: "1" } }); // the next weight that exists: 2
    expect(screen.getByText("5 of 5 nodes · 1 of 4 links shown")).toBeInTheDocument();
    expect(graph().dataset.edges).toBe("0");

    await user.click(within(filters).getByLabelText("Hide nodes without visible links"));
    expect(screen.getByText("2 of 5 nodes · 1 of 4 links shown")).toBeInTheDocument();
    expect(jsonNodeIds(details)).toHaveLength(2);

    await user.click(within(filters).getByRole("button", { name: "Reset" }));
    expect(screen.getByText("4 of 5 nodes · 4 of 4 links shown")).toBeInTheDocument(); // z has no links
  });

  it("explains instead of showing a bar when every link has the same weight", () => {
    const net = sampleNetwork();
    const { filters } = setup({ ...net, edges: net.edges.map((e) => ({ ...e, weight: 1 })) });
    expect(within(filters).getByText("All links have weight 1.")).toBeInTheDocument();
    expect(within(filters).queryByLabelText("Lowest link weight shown")).toBeNull();
  });
});

describe("Show records", () => {
  /** Where "Show records" went: the Records page's path and its filters. */
  function RecordsProbe() {
    const { pathname, search } = useLocation();
    const params = new URLSearchParams(search);
    return (
      <div data-testid="records" data-path={pathname} data-from={params.get("from") ?? ""}>
        {params.getAll("f").join("\n")}
      </div>
    );
  }

  function renderWithRecords(records: RecordsSource, network = sampleNetwork()) {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/runs/5"]}>
        <Routes>
          <Route
            path="/runs/5"
            element={<Explorer network={network} title="Test network" records={records} />}
          />
          <Route path="/datasets/:datasetId/records" element={<RecordsProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    return user;
  }

  const filtersOf = (el: HTMLElement) =>
    (el.textContent ?? "").split("\n").map((f) => JSON.parse(f) as string[]);

  it("offers Show records only for nodes whose type maps to a records column", async () => {
    const mapped = {
      author: "Author Full Names",
      institution: "Institutions (parsed)",
      journal: "Source Title",
      organization: "Affiliations",
      funder: "Funding Orgs",
      wos_category: "WoS Categories",
      research_area: "Research Areas",
      article: "UT (Unique WOS ID)",
    };
    for (const [entity, column] of Object.entries(mapped)) {
      const user = renderWithRecords({ datasetId: 7, entity, link: "same_article" });
      await user.click(screen.getByRole("button", { name: "tap node a" }));
      const details = screen.getByRole("complementary", { name: "Details" });
      const link = within(details).getByRole("link", { name: "Show records" });
      const params = new URL(link.getAttribute("href")!, "http://x").searchParams;
      expect(JSON.parse(params.get("f")!)[0]).toBe(column);
      cleanup();
    }
    for (const entity of ["country", "corresponding_institution", undefined]) {
      const user = renderWithRecords({ datasetId: 7, entity, link: "keywords" });
      await user.click(screen.getByRole("button", { name: "tap node a" }));
      const details = screen.getByRole("complementary", { name: "Details" });
      expect(within(details).getByRole("heading", { name: "Rossi, Anna" })).toBeInTheDocument();
      expect(within(details).queryByRole("link", { name: "Show records" })).toBeNull();
      cleanup();
    }
    // A local file has no dataset: never offered.
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "tap node a" }));
    expect(screen.queryByRole("link", { name: "Show records" })).toBeNull();
  });

  it("Show records on a node opens Records filtered on its value", async () => {
    const user = renderWithRecords({ datasetId: 7, entity: "author", link: "same_article" });
    await user.click(screen.getByRole("button", { name: "tap node a" }));
    await user.click(screen.getByRole("link", { name: "Show records" }));
    const page = screen.getByTestId("records");
    expect(page.dataset.path).toBe("/datasets/7/records");
    expect(page.dataset.from).toBe("node"); // the Records page shows the column even if hidden
    expect(filtersOf(page)).toEqual([["Author Full Names", "contains", "Rossi, Anna"]]);
  });

  it("Show records on a keyword link filters on both endpoints and the shared items", async () => {
    const network = sampleNetwork();
    network.edges[0]!.attr = { evidence: ["deep learning", "fetal ultrasound"] };
    const cases: [string, string][] = [
      ["keywords", "Keywords (normalized)"],
      ["author_keywords", "Author Keywords"],
      ["keywords_plus", "Keywords Plus"],
    ];
    for (const [link, column] of cases) {
      const user = renderWithRecords({ datasetId: 7, entity: "institution", link }, network);
      await user.click(screen.getByRole("button", { name: "tap edge 0" }));
      await user.click(screen.getByRole("link", { name: "Show records" }));
      const page = screen.getByTestId("records");
      expect(page.dataset.from).toBe("link");
      expect(filtersOf(page)).toEqual([
        ["Institutions (parsed)", "contains", "Rossi, Anna; Bianchi, Marco"],
        [column, "contains", "deep learning; fetal ultrasound"],
      ]);
      cleanup();
    }
    // Links on other fields: not offered.
    const user = renderWithRecords(
      { datasetId: 7, entity: "institution", link: "wos_categories" },
      network,
    );
    await user.click(screen.getByRole("button", { name: "tap edge 0" }));
    expect(
      screen.getByRole("heading", { name: "Rossi, Anna — Bianchi, Marco" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Show records" })).toBeNull();
  });
});

describe("assistant actions", () => {
  const RUN = {
    id: 5,
    dataset_id: 7,
    relation: "author",
    params: {},
    status: "succeeded",
    error: null,
    node_count: 5,
    edge_count: 4,
    created_at: "2026-11-12T10:00:00Z",
    started_at: null,
    finished_at: null,
  };

  afterEach(() => vi.unstubAllGlobals());

  /** The explorer with the assistant panel; each question gets the next actions. */
  function setupAssistant(network = sampleNetwork()) {
    const replies: ExplorerAction[][] = [];
    let n = 0;
    mockApi({
      "GET /assistant/status": () => ({ body: { enabled: true } }),
      "GET /runs/5": () => ({ body: RUN }),
      "POST /assistant/chat": () => ({ body: answer(`Done ${++n}`, { actions: replies.shift() }) }),
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/runs/5"]}>
          <AssistantProvider>
            <AssistantButton />
            <Routes>
              <Route
                path="/runs/5"
                element={<Explorer network={network} title="Test network" runId={5} />}
              />
            </Routes>
            <AssistantPanel />
          </AssistantProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const filters = screen.getByRole("complementary", { name: "Filters" });
    const details = screen.getByRole("complementary", { name: "Details" });
    /** Asks once with these actions; returns the action lines under the reply. */
    const apply = async (...actions: ExplorerAction[]) => {
      replies.push(actions);
      const expected = `Done ${n + 1}`;
      const panel = await ask(user, "Change the view");
      const reply = (await within(panel).findByText(expected)).parentElement!;
      const list = within(reply).queryByRole("list", { name: "Applied in the explorer" });
      return list
        ? within(list)
            .getAllByRole("listitem")
            .map((li) => li.textContent)
        : [];
    };
    return { user, filters, details, apply };
  }

  const groupBox = (filters: HTMLElement, name: RegExp) =>
    within(within(filters).getByRole("group", { name: /Group/ })).getByRole("checkbox", { name });
  const swatches = (filters: HTMLElement) =>
    [...within(filters).getByRole("group", { name: /Group/ }).querySelectorAll(".swatch")].map(
      (s) => (s as HTMLElement).style.background,
    );
  const weightStatus = (filters: HTMLElement) =>
    within(filters).getByText(/^Showing weight/).textContent;

  it("applies assistant actions to the explorer controls", async () => {
    const { user, filters, apply } = setupAssistant();
    const lines = await apply(
      { kind: "keep_largest_groups", n: 1 },
      { kind: "set_weight_range", min: 2, max: null },
      { kind: "set_hide_unlinked", on: true },
      { kind: "set_search", text: "Rossi" },
    );
    expect(lines).toEqual([
      "Showing the largest group",
      "Showing links of weight 2–2",
      "Hiding nodes without visible links",
      'Searching for "Rossi": 1 match',
    ]);
    // The controls show it, as if the user had set them.
    expect(groupBox(filters, /Italy/)).toBeChecked();
    expect(groupBox(filters, /USA/)).not.toBeChecked();
    expect(groupBox(filters, /Other/)).not.toBeChecked();
    expect(weightStatus(filters)).toMatch(/^Showing weight 2–2/);
    expect(within(filters).getByLabelText("Hide nodes without visible links")).toBeChecked();
    expect(within(filters).getByRole("searchbox", { name: "Find by node name" })).toHaveValue(
      "Rossi",
    );
    expect(graph().dataset.nodes).toBe("a,b");
    expect(graph().dataset.search).toBe("rossi");

    // ...and the user can change them by hand.
    await user.click(groupBox(filters, /USA/));
    await user.click(within(filters).getByLabelText("Hide nodes without visible links"));
    expect(graph().dataset.nodes).toBe("a,b,c,z");
  });

  it("assistant keeps the N largest groups without repainting them", async () => {
    const { filters, apply } = setupAssistant();
    const colors = swatches(filters);
    expect(await apply({ kind: "keep_largest_groups", n: 2 })).toEqual([
      "Showing the 2 largest groups",
    ]);
    // Italy and USA (legend order), never "other".
    expect(graph().dataset.nodes).toBe("a,b,c,z");
    expect(groupBox(filters, /Other/)).not.toBeChecked();
    expect(swatches(filters)).toEqual(colors);

    expect(await apply({ kind: "groups_by_rank", ranks: [2, 3] })).toEqual([
      "Showing group 2",
      "No group 3: this network has 2 groups.",
    ]);
    expect(graph().dataset.nodes).toBe("c,z");
    expect(groupBox(filters, /Italy/)).not.toBeChecked();
    expect(groupBox(filters, /USA/)).toBeChecked();
    expect(swatches(filters)).toEqual(colors);
  });

  it("assistant shows and hides relation types", async () => {
    const { user, filters, apply } = setupAssistant();
    // Every type is checked, so the control isn't shown.
    expect(within(filters).queryByRole("group", { name: "Relationship" })).toBeNull();

    expect(
      await apply({
        kind: "set_relations",
        relations: ["collaborates_with", "cites"],
        visible: false,
      }),
    ).toEqual(["No relation cites in this network.", "Hiding links of type Collaborates With"]);
    expect(graph().dataset.edges).toBe("2"); // only shares_keywords_with
    expect(graph().dataset.nodes).toBe("a,b,c,d,z"); // links hidden, never nodes
    const relations = within(filters).getByRole("group", { name: "Relationship" });
    expect(
      within(relations).getByRole("checkbox", { name: "Collaborates With" }),
    ).not.toBeChecked();

    expect(
      await apply({ kind: "set_relations", relations: ["Collaborates with"], visible: true }),
    ).toEqual(["Showing links of type Collaborates With"]);
    expect(graph().dataset.edges).toBe("0,1,2,3");

    // By hand, too.
    await apply({ kind: "set_relations", relations: ["shares_keywords_with"], visible: false });
    await user.click(within(filters).getByRole("checkbox", { name: "Shares Keywords With" }));
    expect(graph().dataset.edges).toBe("0,1,2,3");
  });

  it("assistant sets the link weight range, clamped to the network's weights, and hides unlinked nodes", async () => {
    const { filters, apply } = setupAssistant();
    expect(await apply({ kind: "set_weight_range", min: 0, max: 99 })).toEqual([
      "Showing links of weight 1–2",
    ]);
    expect(graph().dataset.edges).toBe("0,1,2,3");
    expect(within(filters).queryByRole("button", { name: "Reset" })).toBeNull(); // full range

    expect(
      await apply(
        { kind: "set_weight_range", min: 5, max: null },
        { kind: "set_hide_unlinked", on: true },
      ),
    ).toEqual(["Showing links of weight 2–2", "Hiding nodes without visible links"]);
    expect(graph().dataset.edges).toBe("0");
    expect(graph().dataset.nodes).toBe("a,b");
    expect(weightStatus(filters)).toMatch(/^Showing weight 2–2/);

    expect(await apply({ kind: "set_hide_unlinked", on: false })).toEqual([
      "Showing nodes without visible links",
    ]);
    expect(within(filters).getByLabelText("Hide nodes without visible links")).not.toBeChecked();
    expect(graph().dataset.nodes).toBe("a,b,c,d,z");
  });

  it("assistant applies attribute filters with the values the user typed", async () => {
    const { filters, apply } = setupAssistant();
    expect(
      await apply(
        {
          kind: "add_attribute_filter",
          target: "nodes",
          attribute: "institution",
          values: ["Parma", "Mayo"],
        },
        { kind: "add_attribute_filter", target: "nodes", attribute: "planet", values: ["Mars"] },
        {
          kind: "add_attribute_filter",
          target: "links",
          attribute: "article_titles",
          values: ["fetal"],
        },
      ),
    ).toEqual([
      "Filtering nodes by institution: Parma; Mayo",
      "No attribute planet in this network.",
      "Filtering links by article_titles: fetal",
    ]);
    // As Apply does: OR within a row, rows AND; link rows drop nodes left unlinked.
    expect(graph().dataset.edges).toBe("0");
    expect(graph().dataset.nodes).toBe("a,b,z");
    // The rows show what was applied, as typed.
    const nodes = within(filters).getByRole("group", { name: "Nodes" });
    expect(within(nodes).getByRole("combobox", { name: /institution contains/ })).toHaveValue(
      "Parma; Mayo",
    );
    expect(within(nodes).getByRole("status")).toHaveTextContent("1 applied");
    const links = within(filters).getByRole("group", { name: "Links" });
    expect(within(links).getByRole("combobox", { name: /article_titles contains/ })).toHaveValue(
      "fetal",
    );
    expect(within(filters).getByText(/Attribute search · 2 applied/)).toBeInTheDocument();
  });

  it("assistant searches and selects the n-th match", async () => {
    const { details, apply } = setupAssistant();
    const selection = within(details).getByRole("region", { name: "Selection" });
    expect(await apply({ kind: "set_search", text: "an" }, { kind: "select_match", n: 2 })).toEqual(
      ['Searching for "an": 4 matches', "Selected Bianchi, Marco"],
    );
    expect(within(selection).getByRole("heading")).toHaveTextContent("Bianchi, Marco");

    expect(await apply({ kind: "select_match", n: 5 })).toEqual(['Only 4 matches for "an".']);
    expect(within(selection).queryByRole("heading")).toBeNull();
    expect(within(selection).getByText(/Click a node or link/)).toBeInTheDocument();
  });

  it("assistant fits the view and resets the filters", async () => {
    const { filters, apply } = setupAssistant();
    expect(graph().dataset.fit).toBe("0");
    expect(await apply({ kind: "fit" })).toEqual(["Fitted the view to the visible graph"]);
    expect(graph().dataset.fit).toBe("1");

    await apply(
      { kind: "keep_largest_groups", n: 1 },
      { kind: "set_relations", relations: ["collaborates_with"], visible: false },
      { kind: "set_weight_range", min: 2, max: 2 },
      { kind: "set_hide_unlinked", on: true },
      {
        kind: "add_attribute_filter",
        target: "nodes",
        attribute: "institution",
        values: ["Parma"],
      },
      { kind: "set_search", text: "Rossi" },
      { kind: "select_match", n: 1 },
    );
    expect(await apply({ kind: "reset" })).toEqual(["Reset the explorer"]);
    expect(screen.getByText("5 of 5 nodes · 4 of 4 links shown")).toBeInTheDocument();
    for (const name of [/Italy/, /USA/, /Other/]) expect(groupBox(filters, name)).toBeChecked();
    expect(within(filters).queryByRole("group", { name: "Relationship" })).toBeNull();
    expect(within(filters).getByLabelText("Hide nodes without visible links")).not.toBeChecked();
    expect(within(filters).queryByRole("button", { name: "Reset" })).toBeNull();
    expect(within(filters).getByRole("searchbox", { name: "Find by node name" })).toHaveValue("");
    const nodes = within(filters).getByRole("group", { name: "Nodes" });
    expect(within(nodes).getByRole("combobox", { name: /contains/ })).toHaveValue("");
    expect(within(filters).queryByText(/applied/)).toBeNull();
  });
});
