// Parity with the original viewer: legacy/graph_network_prototype2.html is
// loaded in jsdom and driven the way a user would (dispatched DOM events on its
// checkboxes, attribute rows and Apply buttons). What its Readable and JSON
// panels then list must equal what lib/visibility computes for the same filters,
// on the real golden networks.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import type { Network } from "./network";
import {
  computeVisibility,
  initialFilterState,
  parseAttrRows,
  type FilterState,
} from "./visibility";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const repo = (p: string) => resolve(REPO_ROOT, p);
const PROTOTYPE = readFileSync(repo("legacy/graph_network_prototype2.html"), "utf-8");
const golden = (name: string): Network =>
  JSON.parse(readFileSync(repo(`backend/tests/fixtures/golden/${name}`), "utf-8"));

/** Just enough of the Cytoscape API for the prototype to run (it only toggles classes). */
function fakeCytoscape(opts: {
  elements: { nodes: { data: { id: string } }[]; edges: { data: { id: string } }[] };
}) {
  const el = (d: { id: string }) => ({
    id: () => d.id,
    data: (k: string) => (d as Record<string, unknown>)[k],
    toggleClass() {},
    addClass() {},
    removeClass() {},
    select() {},
    unselect() {},
  });
  const coll = (items: ReturnType<typeof el>[]) =>
    Object.assign(items, { removeClass() {}, unselect() {} });
  const nodes = opts.elements.nodes.map((n) => el(n.data));
  const edges = opts.elements.edges.map((e) => el(e.data));
  return {
    nodes: () => coll(nodes),
    edges: () => coll(edges),
    batch: (fn: () => void) => fn(),
    on() {},
    destroy() {},
    resize() {},
  };
}

class Prototype {
  private dom: JSDOM;
  private doc: Document;
  private net: Network;

  constructor(network: Network) {
    this.net = network;
    this.dom = new JSDOM(PROTOTYPE, { runScripts: "dangerously", pretendToBeVisual: true });
    // Globals the prototype's inline script defines or expects.
    const win = this.dom.window as unknown as typeof this.dom.window & {
      cytoscape: typeof fakeCytoscape;
      loadGraph: (n: Network, label: string) => void;
    };
    win.cytoscape = fakeCytoscape;
    win.HTMLElement.prototype.scrollIntoView = () => {};
    this.doc = win.document;
    win.loadGraph(structuredClone(network), "golden");
  }

  private fire(el: Element, type: string) {
    el.dispatchEvent(new this.dom.window.Event(type, { bubbles: true }));
  }

  uncheck(container: "team-filters" | "rel-filters", attr: "team" | "rel", value: string) {
    const box = this.doc.querySelector<HTMLInputElement>(
      `#${container} input[data-${attr}="${value}"]`,
    );
    if (!box) throw new Error(`no checkbox ${value}`);
    box.checked = false;
    this.fire(box, "change");
  }

  /** Fill attribute-search rows through the UI (add row, pick key, type), then Apply. */
  attrSearch(prefix: "node-attr" | "edge-attr", rows: { key: string; value: string }[]) {
    rows.forEach((row, i) => {
      if (i > 0) this.fire(this.doc.getElementById(`${prefix}-add-row`)!, "click");
      const select = this.doc.querySelectorAll<HTMLSelectElement>(
        `#${prefix}-rows .attr-key-select`,
      )[i]!;
      select.value = row.key;
      this.fire(select, "change");
      const input = this.doc.querySelectorAll<HTMLInputElement>(
        `#${prefix}-rows .attr-value-input`,
      )[i]!;
      input.value = row.value;
      this.fire(input, "input");
    });
    this.fire(this.doc.getElementById(`${prefix}-apply`)!, "click");
  }

  /** Visible nodes from the Readable tab, visible edges from the JSON tab. */
  shown() {
    this.fire(this.doc.querySelector('.dtab[data-view="friendly"]')!, "click");
    const nodes = [...this.doc.querySelectorAll(".person-row")].map((r) =>
      r.getAttribute("data-id"),
    );
    this.fire(this.doc.querySelector('.dtab[data-view="json"]')!, "click");
    const edges = [...this.doc.querySelectorAll(".json-item")]
      .map((r) => r.getAttribute("data-id")!)
      .filter((id) => /^e\d+$/.test(id))
      .map((id) => Number(id.slice(1)));
    return { nodes, edges };
  }

  /** The same view computed by lib/visibility. */
  expected(patch: Partial<FilterState>) {
    const v = computeVisibility(this.net, { ...initialFilterState(this.net), ...patch });
    return {
      nodes: v.visibleNodes().map((n) => n.id),
      edges: v.visibleEdges().map((e) => this.net.edges.indexOf(e)),
    };
  }
}

describe("parity with legacy/graph_network_prototype2.html", () => {
  const author = golden("network_author.json");
  const inst = golden("network_institution_keywords.json");

  it("shows everything initially", () => {
    const p = new Prototype(author);
    const shown = p.shown();
    expect(shown.nodes.length).toBe(author.nodes.length);
    expect(shown.edges.length).toBe(author.edges.length);
    expect(shown).toEqual(p.expected({}));
  });

  it("Group checkbox", () => {
    const p = new Prototype(author);
    p.uncheck("team-filters", "team", "Peoples R China");
    const teams = new Set(author.nodes.map((n) => n.team).filter((t) => t !== "Peoples R China"));
    const shown = p.shown();
    expect(shown.nodes.length).toBeLessThan(author.nodes.length);
    expect(shown).toEqual(p.expected({ teams }));
  });

  it("Relationship checkbox hides edges only", () => {
    const p = new Prototype(author);
    p.uncheck("rel-filters", "rel", "collaborates_with");
    const shown = p.shown();
    expect(shown).toEqual(p.expected({ relations: new Set() }));
    expect(shown.nodes.length).toBe(author.nodes.length);
  });

  it("node attribute search: OR within a row, AND across rows", () => {
    const rows = [
      { key: "institution", value: "univ, hosp" },
      { key: "author_keywords", value: "deep learning" },
    ];
    const p = new Prototype(author);
    p.attrSearch("node-attr", rows);
    const shown = p.shown();
    expect(shown.nodes.length).toBeGreaterThan(0);
    expect(shown).toEqual(p.expected({ nodeAttr: parseAttrRows(rows) }));
  });

  it("edge attribute search cascades to nodes", () => {
    const rows = [{ key: "article_titles", value: "review" }];
    const p = new Prototype(author);
    p.attrSearch("edge-attr", rows);
    const shown = p.shown();
    expect(shown.edges.length).toBeGreaterThan(0);
    expect(shown.edges.length).toBeLessThan(author.edges.length);
    expect(shown).toEqual(p.expected({ edgeAttr: parseAttrRows(rows) }));
  });

  it("everything combined, on the institution network", () => {
    const nodeRows = [{ key: "city", value: "beijing, shanghai, london" }];
    const edgeRows = [{ key: "shared_keywords", value: "cancer, imaging" }];
    const p = new Prototype(inst);
    p.uncheck("team-filters", "team", "USA");
    p.attrSearch("node-attr", nodeRows);
    p.attrSearch("edge-attr", edgeRows);
    const teams = new Set(inst.nodes.map((n) => n.team).filter((t) => t !== "USA"));
    const shown = p.shown();
    expect(shown.nodes.length).toBeGreaterThan(0);
    expect(shown.nodes.length).toBeLessThan(inst.nodes.length);
    expect(shown).toEqual(
      p.expected({ teams, nodeAttr: parseAttrRows(nodeRows), edgeAttr: parseAttrRows(edgeRows) }),
    );
  });
});
