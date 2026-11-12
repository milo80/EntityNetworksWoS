// Explorer behavior through real user interaction (DOM events via user-event).
// Cytoscape needs a canvas jsdom doesn't have, so GraphView is replaced by a
// probe that exposes what the Explorer asked the graph to show.
import { render, screen, within } from "@testing-library/react";
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
      <button type="button" onClick={() => p.onSelect({ kind: "edge", index: 0, from: "graph" })}>
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

function setup() {
  const user = userEvent.setup();
  render(<Explorer network={sampleNetwork()} title="Test network" />);
  const filters = screen.getByRole("complementary", { name: "Filters" });
  const details = screen.getByRole("complementary", { name: "Details" });
  return { user, filters, details };
}

const graph = () => screen.getByTestId("graph");
const readableNames = (details: HTMLElement) =>
  within(details)
    .queryAllByRole("listitem")
    .map((li) => li.querySelector(".name")!.textContent);
const jsonText = (details: HTMLElement) => details.querySelector(".json-view")?.textContent ?? "";

describe("Explorer", () => {
  it("starts with everything visible", () => {
    const { details } = setup();
    expect(screen.getByText("5 of 5 nodes · 4 of 4 links shown")).toBeInTheDocument();
    expect(graph().dataset.nodes).toBe("a,b,c,d,z");
    expect(readableNames(details)).toHaveLength(5);
  });

  it("Group checkbox hides nodes everywhere (graph, count, Readable, JSON)", async () => {
    const { user, filters, details } = setup();
    await user.click(within(filters).getByRole("checkbox", { name: /USA/ }));

    expect(graph().dataset.nodes).toBe("a,b,d");
    expect(graph().dataset.edges).toBe("0");
    expect(screen.getByText("3 of 5 nodes · 1 of 4 links shown")).toBeInTheDocument();
    expect(readableNames(details)).toEqual(["Rossi, Anna", "Bianchi, Marco", "Wang, Li"]);

    await user.click(within(details).getByRole("tab", { name: "JSON" }));
    const json = jsonText(details);
    expect(json).toContain('"id": "a"');
    expect(json).not.toContain('"id": "c"');
    expect(json.match(/"source"/g)).toHaveLength(1);
  });

  it("Relationship checkbox hides links but keeps nodes", async () => {
    const { user, filters } = setup();
    await user.click(within(filters).getByRole("checkbox", { name: "Collaborates With" }));
    expect(graph().dataset.nodes).toBe("a,b,c,d,z");
    expect(graph().dataset.edges).toBe("2");
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
    await user.type(within(filters).getByRole("searchbox", { name: "Find by name" }), "ROSSI");
    expect(graph().dataset.search).toBe("rossi");
    expect(screen.getByText("1 match highlighted")).toBeInTheDocument();
    expect(graph().dataset.nodes).toBe("a,b,c,d,z");
    expect(readableNames(details)).toHaveLength(5);
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
      "parma, mayo",
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

  it("selecting in the list shows details; tapping a link in the graph shows the link", async () => {
    const { user, details } = setup();
    await user.click(within(details).getByText("Lee, Kim"));
    const selection = within(details).getByRole("region", { name: "Selection" });
    expect(within(selection).getByRole("heading")).toHaveTextContent("Lee, Kim");
    expect(within(selection).getByText("Rochester")).toBeInTheDocument();
    const list = within(details).getByRole("list");
    expect(within(list).getByText("Lee, Kim").closest("li")).toHaveClass("selected");

    await user.click(screen.getByRole("button", { name: "tap edge 0" }));
    expect(within(selection).getByRole("heading")).toHaveTextContent(
      "Rossi, Anna — Bianchi, Marco",
    );
    expect(within(selection).getByText("Fetal imaging with AI")).toBeInTheDocument();
  });

  it("filter list doubles as the legend: largest groups first, other/unknown last", () => {
    const { filters } = setup();
    const groups = within(filters).getByRole("group", { name: /Group/ });
    const labels = within(groups)
      .getAllByRole("checkbox")
      .map((c) => c.closest("label")!.textContent);
    expect(labels).toEqual(["Italy2", "USA2", "Other1"]);
  });
});
