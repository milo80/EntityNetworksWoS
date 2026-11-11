"""Graph sampling for display."""

from __future__ import annotations

import networkx as nx


def build_connected_sample(G: nx.Graph, target_size: int = 40, min_component_size: int = 3) -> nx.Graph:
    """Sample up to ``target_size`` nodes from the largest connected components.

    Picking the global top-N by degree can produce a near-disconnected sample
    once mega-papers are removed. Instead, components are taken largest first,
    and within each component the highest-degree nodes are kept.

    Deterministic: ties (same component size, same degree) are broken by the
    node order of ``G``, and the result keeps G's node and edge order. The legacy
    version iterated Python sets here, so the sample changed between runs.
    """
    order = {n: i for i, n in enumerate(G.nodes())}
    components = [sorted(c, key=order.__getitem__)
                  for c in nx.connected_components(G) if len(c) >= min_component_size]
    components.sort(key=len, reverse=True)

    selected: list = []
    for component in components:
        if len(selected) >= target_size:
            break
        remaining = target_size - len(selected)
        # A connected component's induced degree equals its degree in G.
        ranked = sorted(component, key=lambda n: -G.degree(n))
        selected.extend(ranked[:remaining])

    keep = set(selected)
    H = nx.Graph()
    H.add_nodes_from((n, dict(G.nodes[n])) for n in G.nodes() if n in keep)
    H.add_edges_from((u, v, dict(d)) for u, v, d in G.edges(data=True) if u in keep and v in keep)
    return H
