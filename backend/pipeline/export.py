"""Convert a graph to the frontend's network JSON contract (see docs/design-notes.md).

    {"nodes": [{"id", "name", "team", "role", "attr"?}],
     "edges": [{"source", "target", "type", "weight", "attr"?}]}
"""

from __future__ import annotations

import logging
from collections import Counter

import networkx as nx
from networkx.algorithms.community import greedy_modularity_communities

from .sampling import build_connected_sample

log = logging.getLogger(__name__)


def _teams_from_attribute(G_sub: nx.Graph, team_attribute: str, max_team_categories: int,
                          min_team_size: int) -> dict:
    """team = the node's attribute value; rare values -> "other", missing -> "unknown"."""
    value_counts = Counter(G_sub.nodes[n].get(team_attribute) for n in G_sub.nodes()
                           if G_sub.nodes[n].get(team_attribute))
    kept = {v for v, c in value_counts.most_common(max_team_categories) if c >= min_team_size}

    def team_for(n):
        val = G_sub.nodes[n].get(team_attribute)
        if not val:
            return "unknown"
        return val if val in kept else "other"

    return {n: team_for(n) for n in G_sub.nodes()}


def _teams_from_communities(G: nx.Graph, max_communities: int, min_community_size: int) -> dict:
    """team = detected community (computed on the full graph, not the sample)."""
    communities = list(greedy_modularity_communities(G)) if G.number_of_edges() > 0 else []
    node_to_team = {}
    for i, community in enumerate(sorted(communities, key=len, reverse=True)):
        keep_separate = i < max_communities and len(community) >= min_community_size
        label = f"cluster_{i}" if keep_separate else "other"
        for node in community:
            node_to_team[node] = label
    return node_to_team


def graph_to_network(G: nx.Graph, top_n: int | None = None, edge_type: str = "related_to",
                     role_suffix: str = "connections", min_community_size: int = 2,
                     max_communities: int = 10, team_attribute: str | None = None,
                     max_team_categories: int = 10, min_team_size: int = 2,
                     node_attrs: tuple[str, ...] | None = None,
                     edge_attrs: tuple[str, ...] | None = None) -> dict:
    """Build the network JSON dict for ``G``.

    - top_n: if G is larger, export a connected sample (build_connected_sample).
    - team_attribute: color/group by a real node attribute (e.g. 'country');
      otherwise fall back to community detection.
    - node_attrs / edge_attrs: attribute names copied into a nested "attr" dict
      (display/search only). Empty values are omitted; "attr" is omitted if empty.
      Edge attributes must already be flat (e.g. 'shared_keywords').
    """
    G_sub = build_connected_sample(G, target_size=top_n) if top_n is not None and \
        G.number_of_nodes() > top_n else G

    if team_attribute:
        node_to_team = _teams_from_attribute(G_sub, team_attribute, max_team_categories, min_team_size)
    else:
        node_to_team = _teams_from_communities(G, max_communities, min_community_size)

    nodes = []
    for n in G_sub.nodes():
        data = G_sub.nodes[n]
        node_obj = {"id": n, "name": data.get("display_name", n),
                    "team": node_to_team.get(n, "other"),
                    "role": f"{G_sub.degree(n)} {role_suffix}"}
        if node_attrs:
            attrs = {f: data.get(f) for f in node_attrs if data.get(f)}
            if attrs:
                node_obj["attr"] = attrs
        nodes.append(node_obj)

    edges = []
    for u, v, edata in G_sub.edges(data=True):
        edge_obj = {"source": u, "target": v, "type": edge_type, "weight": edata.get("weight", 1)}
        if edge_attrs:
            attrs = {f: edata.get(f) for f in edge_attrs if edata.get(f)}
            if attrs:
                edge_obj["attr"] = attrs
        edges.append(edge_obj)

    log.info("Exported %d nodes and %d edges; teams: %s",
             len(nodes), len(edges), dict(Counter(n["team"] for n in nodes)))
    return {"nodes": nodes, "edges": edges}
