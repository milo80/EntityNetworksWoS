"""Explore a Web of Science export and suggest custom-network settings.

Read-only: reads .xls files, writes nothing (unless --json is given).

    backend/.venv/bin/python .claude/skills/wos-explore/scripts/explore.py data/wos
    backend/.venv/bin/python .claude/skills/wos-explore/scripts/explore.py data/wos \
        --entity institution --link keywords --model word_matching
    ... --all            every combination the data supports (minutes on 3,000 articles)

Prints:
  1. columns: fill, distinct values, list-likeness (";"), typical length;
  2. which catalog entities / link fields this data supports (pipeline.custom);
  3. per combination: matched links, weight distribution, and the size of the
     exported network (top_n nodes) at several minimum link weights, with the
     smallest weight that keeps the average degree readable (--target-degree).
"""

from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
import time
from dataclasses import replace
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "backend"))

from pipeline import custom  # noqa: E402
from pipeline.custom import (  # noqa: E402
    CustomParams,
    NetworkBuildError,
    build_custom_graph,
    combination_problem,
)
from pipeline.io import read_wos_files  # noqa: E402
from pipeline.relations import prepare_articles  # noqa: E402
from pipeline.sampling import build_connected_sample  # noqa: E402

WEIGHTS = (1, 2, 3, 5, 10)
# A quick, representative set when neither --all nor a combination is given.
QUICK = [
    ("author", "same_article", "word_matching"),
    ("institution", "keywords", "word_matching"),
    ("country", "keywords", "word_matching"),
    ("organization", "wos_categories", "word_matching"),
    ("journal", "keywords", "word_matching"),
    ("institution", "article_title", "word_overlap"),
    ("institution", "journal", "character_similarity"),
]


def column_report(df) -> list[dict]:
    rows = []
    for c in df.columns:
        s = df[c].dropna()
        s = s[s.astype(str).str.strip() != ""]
        if s.empty:
            rows.append({"column": c, "fill_pct": 0.0})
            continue
        st = s.astype(str)
        rows.append(
            {
                "column": c,
                "fill_pct": round(100 * len(s) / len(df), 1),
                "distinct": int(s.nunique()),
                "list_pct": round(100 * st.str.contains(";").mean(), 1),
                "avg_items": round(st.str.split(";").apply(len).mean(), 1),
                "avg_len": int(st.str.len().mean()),
            }
        )
    return rows


def weight_summary(G) -> dict:
    ws = sorted(w for _, _, w in G.edges(data="weight"))
    if not ws:
        return {"edges": 0}
    pick = lambda p: ws[min(len(ws) - 1, int(p * len(ws)))]  # noqa: E731
    return {
        "edges": len(ws),
        "median": statistics.median(ws),
        "p90": pick(0.9),
        "p99": pick(0.99),
        "max": ws[-1],
        "share_weight_1": round(sum(1 for w in ws if w == 1) / len(ws), 3),
    }


def export_sizes(G, top_n: int) -> dict[int, dict]:
    """Nodes/edges/average degree of the exported sample at each minimum weight."""
    out = {}
    for w in WEIGHTS:
        H = G.edge_subgraph([(u, v) for u, v, x in G.edges(data="weight") if x >= w]).copy()
        H.add_nodes_from(G.nodes)
        S = build_connected_sample(H, top_n) if H.number_of_nodes() > top_n else H
        n, e = S.number_of_nodes(), S.number_of_edges()
        out[w] = {"nodes": n, "edges": e, "avg_degree": round(2 * e / n, 1) if n else 0.0}
    return out


def suggest_weight(sizes: dict[int, dict], target: float) -> int | None:
    for w in WEIGHTS:
        s = sizes[w]
        if s["nodes"] >= 30 and s["avg_degree"] <= target:
            return w
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("data", type=Path, help="folder with WoS .xls exports, or one .xls file")
    ap.add_argument("--entity")
    ap.add_argument("--link")
    ap.add_argument("--model")
    ap.add_argument("--all", action="store_true", help="every supported combination")
    ap.add_argument("--top-n", type=int, default=CustomParams.top_n)
    ap.add_argument("--target-degree", type=float, default=8.0)
    ap.add_argument("--set", action="append", default=[], metavar="PARAM=VALUE",
                    help="override a CustomParams value, e.g. --set min_shared=3")
    ap.add_argument("--json", type=Path, help="also write the full results here")
    args = ap.parse_args()

    logging.disable(logging.CRITICAL)
    files = sorted(args.data.glob("*.xls")) if args.data.is_dir() else [args.data]
    raw = read_wos_files(files)
    articles = prepare_articles(raw)
    print(f"{len(raw)} records in {len(files)} file(s); {len(articles)} after the mega-paper filter\n")

    cols = column_report(raw)
    print("COLUMNS (fill% distinct list% avg_items avg_len)")
    for r in cols:
        if r["fill_pct"] >= 1:
            print(f"  {r['column'][:40]:40} {r['fill_pct']:5.0f} {r.get('distinct', 0):7} "
                  f"{r.get('list_pct', 0):5.0f} {r.get('avg_items', 0):5.1f} {r.get('avg_len', 0):6}")

    fill = {r["column"]: r["fill_pct"] for r in cols}
    avail = custom.availability(fill)
    print("\nCATALOG AVAILABILITY")
    for group in ("entities", "links"):
        ok = [k for k, v in avail[group].items() if v is None]
        missing = {k: v for k, v in avail[group].items() if v}
        print(f"  {group}: {', '.join(ok)}")
        for k, why in missing.items():
            print(f"    not available: {k} ({why})")

    overrides = {}
    for item in args.set:
        key, _, value = item.partition("=")
        default = getattr(CustomParams, key)
        overrides[key] = type(default)(value)

    if args.entity or args.link or args.model:
        combos = [(args.entity or "institution", args.link or "keywords",
                   args.model or "word_matching")]
    elif args.all:
        combos = [(e, lk, m) for e in custom.ENTITIES for lk, s in custom.LINKS.items()
                  for m in s.models]
    else:
        combos = QUICK

    results = []
    print(f"\nCOMBINATIONS (exported network of up to {args.top_n} nodes; "
          f"avg degree per min link weight {WEIGHTS})")
    for entity, link, model in combos:
        problem = combination_problem(entity, link, model)
        if problem or avail["entities"][entity] or avail["links"][link]:
            if not args.all:
                print(f"  {entity} x {link} x {model}: skipped ({problem or 'not in this data'})")
            continue
        params = CustomParams(entity=entity, link=link, model=model,
                              threshold=custom.THRESHOLD_DEFAULTS.get(model, CustomParams.threshold))
        params = replace(params, min_weight=1, top_n=args.top_n, **overrides)
        t = time.time()
        try:
            G = build_custom_graph(articles, params)
        except NetworkBuildError as exc:
            print(f"  {entity} x {link} x {model}: refused ({exc})")
            continue
        sizes = export_sizes(G, args.top_n)
        weights = weight_summary(G)
        best = suggest_weight(sizes, args.target_degree)
        degrees = " ".join(f"{sizes[w]['avg_degree']:6.1f}" for w in WEIGHTS)
        print(f"  {entity:26} {link:16} {model:21} {weights['edges']:8} links  "
              f"deg {degrees}  -> min weight {best or '>10'}  ({time.time() - t:.0f}s)")
        results.append({"entity": entity, "link": link, "model": model,
                        "weights": weights, "export": sizes, "suggested_min_weight": best})

    if args.json:
        args.json.write_text(json.dumps({"columns": cols, "availability": avail,
                                         "combinations": results}, indent=1))
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
