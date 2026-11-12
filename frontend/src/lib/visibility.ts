// Single source of truth for what is visible: the graph, the Readable list and
// the JSON view all read visibleNodes()/visibleEdges() from here, so they can
// never disagree. Ported from legacy/graph_network_prototype2.html, same rules:
//
// - Group checkboxes: a node is hidden when its team is unchecked.
// - Relationship checkboxes: hide EDGES of unchecked types only, never nodes.
// - Node attribute search: hides nodes that don't match (and so their edges).
// - Edge attribute search: hides non-matching edges, and - only while it is
//   active - nodes left with no visible edge. Nodes with no edges at all in the
//   dataset are exempt (an edge filter can't judge them).
// - Edge visibility looks at the endpoints' OWN filters, not their cascaded
//   visibility, which keeps the node <-> edge rules acyclic.
// - Name search is NOT here: it highlights, it never hides.
import type { Attributed, Network, NetworkEdge, NetworkNode } from "./network";

/** One applied attribute-search row: match any of `values` (OR). */
export interface AttrFilter {
  attribute: string;
  /** Lower-cased, trimmed, non-empty terms. */
  values: string[];
}

export interface FilterState {
  /** Checked Group values. */
  teams: ReadonlySet<string>;
  /** Checked Relationship values. */
  relations: ReadonlySet<string>;
  /** Applied node attribute filters (rows combine with AND). */
  nodeAttr: readonly AttrFilter[];
  /** Applied edge attribute filters (rows combine with AND). */
  edgeAttr: readonly AttrFilter[];
}

/** Everything visible: all teams and relations checked, no attribute filters. */
export function initialFilterState(network: Network): FilterState {
  return {
    teams: new Set(network.nodes.map((n) => n.team)),
    relations: new Set(network.edges.map((e) => e.type)),
    nodeAttr: [],
    edgeAttr: [],
  };
}

/**
 * Turn attribute-search rows into applied filters: comma-separated terms in a
 * row are alternatives (OR); empty rows are dropped.
 */
export function parseAttrRows(rows: readonly { key: string; value: string }[]): AttrFilter[] {
  return rows
    .map((row) => ({
      attribute: row.key,
      values: (row.value || "")
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length > 0),
    }))
    .filter((f) => f.values.length > 0);
}

/** Case-insensitive substring match; list values match if any element contains a term. */
export function matchesAttrFilters(item: Attributed, filters: readonly AttrFilter[]): boolean {
  for (const f of filters) {
    const raw = item.attr?.[f.attribute];
    if (raw === undefined || raw === null || raw === "") return false;
    const text = (Array.isArray(raw) ? raw.join(" | ") : String(raw)).toLowerCase();
    if (!f.values.some((v) => text.includes(v))) return false;
  }
  return true;
}

export interface Visibility {
  isNodeVisible(node: NetworkNode): boolean;
  isEdgeVisible(edge: NetworkEdge): boolean;
  visibleNodes(): NetworkNode[];
  visibleEdges(): NetworkEdge[];
}

export function computeVisibility(network: Network, state: FilterState): Visibility {
  const nodeById = new Map(network.nodes.map((n) => [n.id, n]));
  const incident = new Map<string, NetworkEdge[]>();
  for (const e of network.edges) {
    for (const end of [e.source, e.target]) {
      const list = incident.get(end);
      if (list) list.push(e);
      else incident.set(end, [e]);
    }
  }

  const ownCache = new Map<string, boolean>();
  const passesOwnFilters = (n: NetworkNode): boolean => {
    let ok = ownCache.get(n.id);
    if (ok === undefined) {
      ok = state.teams.has(n.team) && matchesAttrFilters(n, state.nodeAttr);
      ownCache.set(n.id, ok);
    }
    return ok;
  };

  const edgeCache = new Map<NetworkEdge, boolean>();
  const isEdgeVisible = (e: NetworkEdge): boolean => {
    let ok = edgeCache.get(e);
    if (ok === undefined) {
      const src = nodeById.get(e.source);
      const tgt = nodeById.get(e.target);
      ok =
        state.relations.has(e.type) &&
        !!src &&
        !!tgt &&
        passesOwnFilters(src) &&
        passesOwnFilters(tgt) &&
        matchesAttrFilters(e, state.edgeAttr);
      edgeCache.set(e, ok);
    }
    return ok;
  };

  const isNodeVisible = (n: NetworkNode): boolean => {
    if (!passesOwnFilters(n)) return false;
    if (state.edgeAttr.length === 0) return true;
    const edges = incident.get(n.id);
    if (!edges || edges.length === 0) return true;
    return edges.some(isEdgeVisible);
  };

  return {
    isNodeVisible,
    isEdgeVisible,
    visibleNodes: () => network.nodes.filter(isNodeVisible),
    visibleEdges: () => network.edges.filter(isEdgeVisible),
  };
}
