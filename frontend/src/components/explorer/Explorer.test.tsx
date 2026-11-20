// Explorer behavior through real user interaction (DOM events via user-event).
// Cytoscape needs a canvas jsdom doesn't have, so GraphView is replaced by a
// probe that exposes what the Explorer asked the graph to show.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { sampleNetwork } from "../../test/fixtures";
import { Explorer } from "./Explorer";

vi.mock("./GraphView", () => ({
  GraphView: (p: {
    visibleNodeIds: Set<string>;
    visibleEdgeIdx: Set<number>;
    search: string;
    onSelect: (s: unknown) => void;
  }) => (
    <div
      data-testid="graph"
      data-nodes={[...p.visibleNodeIds].sort().join(",")}
      data-edges={[...p.visibleEdgeIdx].sort().join(",")}
      data-search={p.search}
    >
      <button type="button" onClick={() => p.onSelect({ kind: "edge", index: 0 })}>
        tap edge 0
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
