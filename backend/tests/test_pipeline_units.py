import os
import subprocess
import sys
from pathlib import Path

import networkx as nx
import pandas as pd

from pipeline.authors import (
    build_orcid_lookup,
    filter_out_mega_papers,
    resolve_author_ids,
    synthetic_author_code,
)
from pipeline.export import graph_to_network
from pipeline.institutions import (
    normalize_country,
    parse_address_block,
    parse_reprint_address_block,
    pick_anchor_institution,
)
from pipeline.keywords import normalize_keyword, parse_keyword_columns
from pipeline.sampling import build_connected_sample

BACKEND_DIR = Path(__file__).resolve().parents[1]


def test_normalize_country():
    assert normalize_country("TX 77807 USA") == "USA"
    assert normalize_country(" Italy ") == "Italy"
    assert normalize_country(None) is None


def test_parse_address_block():
    s = ("[Smith, John; Doe, Ann] Univ Parma, Dept Med & Surg, I-43126 Parma, Italy; "
         "[Lee, Kim] Mayo Clin, Rochester, MN 55905 USA")
    recs = parse_address_block(s)
    assert [r["author_name"] for r in recs] == ["Smith, John", "Doe, Ann", "Lee, Kim"]
    assert recs[0]["institution"] == "Univ Parma"
    assert recs[0]["department"] == "Dept Med & Surg"
    assert recs[0]["city"] == "I-43126 Parma"
    assert recs[0]["country"] == "Italy"
    assert recs[2]["department"] is None
    assert recs[2]["country"] == "USA"
    assert parse_address_block(float("nan")) == []


def test_reprint_and_anchor_prefers_university():
    s = ("Smith, J (corresponding author), Mayo Clin, Rochester, MN USA.; "
         "Smith, J (corresponding author), Univ Minnesota, Dept Surg, Minneapolis, MN USA.")
    recs = parse_reprint_address_block(s)
    assert [r["institution"] for r in recs] == ["Mayo Clin", "Univ Minnesota"]
    assert pick_anchor_institution(recs)["institution"] == "Univ Minnesota"
    assert pick_anchor_institution(recs[:1])["institution"] == "Mayo Clin"
    assert pick_anchor_institution([]) is None


def test_keywords():
    assert normalize_keyword(" ARTIFICIAL-INTELLIGENCE ") == "artificial intelligence"
    df = parse_keyword_columns(pd.DataFrame({"Author Keywords": ["AI; ; Ethics", None]}))
    assert df["author_keywords"].tolist() == [["AI", "Ethics"], []]


def test_author_ids():
    df = pd.DataFrame({"autors": ["Doe, Ann", "Roe, Bob"],
                       "ORCIDs": ["Doe, Ann/0000-0001-2345-6789", None]})
    assert build_orcid_lookup(df) == {"doe, ann": "0000-0001-2345-6789"}
    out = resolve_author_ids(df)
    assert out["author_id"].tolist() == ["0000-0001-2345-6789", synthetic_author_code("Roe, Bob")]
    assert synthetic_author_code(" ROE, bob") == synthetic_author_code("Roe, Bob")


def test_filter_out_mega_papers():
    df = pd.DataFrame({"Author Full Names": ["A; B", "; ".join(f"X{i}" for i in range(16))]})
    assert len(filter_out_mega_papers(df, max_authors=15)) == 1


def test_teams_other_vs_unknown():
    G = nx.Graph()
    G.add_nodes_from([("a", {"country": "Italy"}), ("b", {"country": "Italy"}),
                      ("c", {"country": "Peru"}), ("d", {})])
    teams = {n["id"]: n["team"] for n in graph_to_network(G, team_attribute="country")["nodes"]}
    assert teams == {"a": "Italy", "b": "Italy", "c": "other", "d": "unknown"}


def test_connected_sample_prefers_largest_component():
    G = nx.Graph()
    nx.add_path(G, ["a", "b", "c", "d"])
    nx.add_path(G, ["x", "y", "z"])
    G.add_node("lonely")
    H = build_connected_sample(G, target_size=5)
    assert set(H.nodes()) == {"a", "b", "c", "d", "y"}  # y: highest degree in 2nd component


_SAMPLE_SCRIPT = """
import networkx as nx
from pipeline.sampling import build_connected_sample
G = nx.Graph()
for i in range(30):
    G.add_edge(f"hub{i % 3}", f"leaf{i}")      # many degree ties
    G.add_edge(f"leaf{i}", f"leaf{(i + 1) % 30}")
H = build_connected_sample(G, target_size=12)
print(list(H.nodes()), list(H.edges()))
"""


def test_connected_sample_independent_of_hash_seed():
    outputs = set()
    for seed in ("1", "2", "12345"):
        env = {**os.environ, "PYTHONHASHSEED": seed}
        res = subprocess.run([sys.executable, "-c", _SAMPLE_SCRIPT], cwd=BACKEND_DIR, env=env,
                             capture_output=True, text=True, check=True)
        outputs.add(res.stdout)
    assert len(outputs) == 1
