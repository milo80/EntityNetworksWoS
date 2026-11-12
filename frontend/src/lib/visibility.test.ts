import { describe, expect, it } from "vitest";

import { sampleNetwork } from "../test/fixtures";
import {
  computeVisibility,
  initialFilterState,
  matchesAttrFilters,
  parseAttrRows,
  type FilterState,
} from "./visibility";

const ids = (items: { id: string }[]) => items.map((n) => n.id);
const pairs = (edges: { source: string; target: string }[]) =>
  edges.map((e) => `${e.source}-${e.target}`);

function visible(patch: Partial<FilterState>) {
  const net = sampleNetwork();
  const v = computeVisibility(net, { ...initialFilterState(net), ...patch });
  return { nodes: ids(v.visibleNodes()), edges: pairs(v.visibleEdges()) };
}

describe("initial state", () => {
  it("shows everything", () => {
    expect(visible({})).toEqual({
      nodes: ["a", "b", "c", "d", "z"],
      edges: ["a-b", "a-c", "b-c", "c-d"],
    });
  });
});

describe("Group checkboxes", () => {
  it("hide nodes of unchecked teams and every edge touching them", () => {
    expect(visible({ teams: new Set(["Italy", "other"]) })).toEqual({
      nodes: ["a", "b", "d"],
      edges: ["a-b"],
    });
  });
});

describe("Relationship checkboxes", () => {
  it("hide edges of unchecked types but never their nodes", () => {
    expect(visible({ relations: new Set(["shares_keywords_with"]) })).toEqual({
      nodes: ["a", "b", "c", "d", "z"],
      edges: ["b-c"],
    });
  });
});

describe("parseAttrRows", () => {
  it("splits comma-separated terms, trims, lower-cases and drops empty rows", () => {
    expect(
      parseAttrRows([
        { key: "institution", value: " Univ PARMA , mayo ,," },
        { key: "city", value: "   " },
      ]),
    ).toEqual([{ attribute: "institution", values: ["univ parma", "mayo"] }]);
  });
});

describe("matchesAttrFilters", () => {
  const node = { attr: { institution: "Univ Parma", author_keywords: ["Fetal ultrasound", "AI"] } };
  it("is a case-insensitive substring match", () => {
    expect(matchesAttrFilters(node, [{ attribute: "institution", values: ["parma"] }])).toBe(true);
  });
  it("matches list attributes on any element", () => {
    expect(matchesAttrFilters(node, [{ attribute: "author_keywords", values: ["ultra"] }])).toBe(
      true,
    );
  });
  it("fails when the attribute is missing", () => {
    expect(matchesAttrFilters(node, [{ attribute: "city", values: ["x"] }])).toBe(false);
    expect(matchesAttrFilters({}, [{ attribute: "city", values: ["x"] }])).toBe(false);
  });
  it("passes with no filters", () => {
    expect(matchesAttrFilters({}, [])).toBe(true);
  });
});

describe("node attribute search", () => {
  it("OR within a row", () => {
    const nodeAttr = parseAttrRows([{ key: "institution", value: "parma, mayo" }]);
    expect(visible({ nodeAttr }).nodes).toEqual(["a", "b", "c", "z"]);
  });
  it("AND across rows", () => {
    const nodeAttr = parseAttrRows([
      { key: "institution", value: "parma" },
      { key: "author_keywords", value: "fetal" },
    ]);
    expect(visible({ nodeAttr })).toEqual({ nodes: ["a"], edges: [] });
  });
  it("hides edges whose endpoints fail", () => {
    const nodeAttr = parseAttrRows([{ key: "institution", value: "parma" }]);
    expect(visible({ nodeAttr }).edges).toEqual(["a-b"]);
  });
});

describe("edge attribute search", () => {
  it("hides non-matching edges and nodes left without a visible edge", () => {
    const edgeAttr = parseAttrRows([{ key: "article_titles", value: "fetal" }]);
    expect(visible({ edgeAttr })).toEqual({
      // c and d lose all their edges; z has no edges at all, so it stays.
      nodes: ["a", "b", "z"],
      edges: ["a-b"],
    });
  });
  it("combines with Relationship checkboxes", () => {
    const edgeAttr = parseAttrRows([{ key: "shared_keywords", value: "deep" }]);
    expect(visible({ edgeAttr, relations: new Set(["collaborates_with"]) })).toEqual({
      nodes: ["z"],
      edges: [],
    });
  });
  it("judges edges by endpoints' own filters, not cascaded visibility", () => {
    // Group filter hides d; c stays visible through its edge to a.
    const edgeAttr = parseAttrRows([{ key: "article_titles", value: "review" }]);
    expect(visible({ edgeAttr, teams: new Set(["Italy", "USA"]) })).toEqual({
      nodes: ["a", "c", "z"],
      edges: ["a-c"],
    });
  });
});
