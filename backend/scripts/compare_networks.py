"""Compare two network JSON files and summarize the differences.

Used when a pipeline change is expected to alter output, before regenerating
the golden fixtures:

    python scripts/compare_networks.py tests/fixtures/golden/network_author.json out/network_author.json

Edges are compared as undirected (source/target order ignored). Exit code is 0
when the networks are identical, 1 otherwise.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path


def _edge_key(e: dict) -> tuple:
    return (*sorted((e["source"], e["target"])), e["type"])


def compare(a: dict, b: dict, max_items: int) -> list[str]:
    lines: list[str] = []
    na = {n["id"]: n for n in a["nodes"]}
    nb = {n["id"]: n for n in b["nodes"]}
    ea = {_edge_key(e): e for e in a["edges"]}
    eb = {_edge_key(e): e for e in b["edges"]}

    def show(label: str, items) -> None:
        items = sorted(items)
        lines.append(f"  {label}: {len(items)}")
        for item in items[:max_items]:
            lines.append(f"    {item}")
        if len(items) > max_items:
            lines.append(f"    ... {len(items) - max_items} more")

    lines.append(f"nodes: {len(na)} -> {len(nb)}")
    show("removed nodes", set(na) - set(nb))
    show("added nodes", set(nb) - set(na))
    changed = []
    for k in sorted(set(na) & set(nb)):
        if na[k] != nb[k]:
            fields = sorted(f for f in na[k].keys() | nb[k].keys() if na[k].get(f) != nb[k].get(f))
            detail = ", ".join(
                f"{f}: {na[k].get(f)!r} -> {nb[k].get(f)!r}" if f != "attr" else "attr changed"
                for f in fields)
            changed.append(f"{k} ({na[k].get('name')}): {detail}")
    show("changed nodes", changed)

    lines.append(f"edges: {len(ea)} -> {len(eb)}")
    show("removed edges", set(ea) - set(eb))
    show("added edges", set(eb) - set(ea))
    show("changed edges", [k for k in set(ea) & set(eb)
                           if {**ea[k], "source": 0, "target": 0} != {**eb[k], "source": 0, "target": 0}])

    ta, tb = Counter(n["team"] for n in a["nodes"]), Counter(n["team"] for n in b["nodes"])
    if ta != tb:
        show("team count changes", [f"{t}: {ta[t]} -> {tb[t]}" for t in ta.keys() | tb.keys()
                                    if ta[t] != tb[t]])
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("old", type=Path)
    parser.add_argument("new", type=Path)
    parser.add_argument("--max-items", type=int, default=10, help="items listed per category")
    args = parser.parse_args(argv)

    a = json.loads(args.old.read_text(encoding="utf-8"))
    b = json.loads(args.new.read_text(encoding="utf-8"))
    if a == b:
        print(f"{args.new.name}: identical")
        return 0
    print(f"{args.old} -> {args.new}")
    print("\n".join(compare(a, b, args.max_items)))
    return 1


if __name__ == "__main__":
    sys.exit(main())
