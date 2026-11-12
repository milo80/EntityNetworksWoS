"""Graph builders: author co-authorship, institution keyword similarity, grouped co-occurrence."""

from __future__ import annotations

import logging
import re
from collections import Counter
from itertools import combinations

import networkx as nx
import pandas as pd

from .institutions import ARTICLE_ID
from .keywords import build_article_keyword_profiles, compute_keyword_document_frequency

log = logging.getLogger(__name__)

ORCID_PATTERN = re.compile(r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$")


def create_author_network(df_exploded: pd.DataFrame, id_column: str = "author_id",
                          name_column: str = "display_name",
                          extra_attributes: tuple[str, ...] = ("institution", "institution_department",
                                                               "department", "city", "country"),
                          list_attributes: tuple[str, ...] = ("author_keywords", "keywords_plus"),
                          ) -> nx.Graph:
    """Co-authorship graph from exploded author rows.

    Nodes are keyed by ``id_column`` and carry 'display_name', 'has_orcid', the
    author's most common value of each scalar attribute, and the case-insensitive
    union of each list attribute (e.g. keywords) across their articles.

    Edges carry 'weight' (shared articles), 'articles' (id, title, author
    positions) and 'article_titles' (flat sorted titles, for export).
    """
    G = nx.Graph()

    if id_column not in df_exploded.columns:
        id_column = "autors"
    if name_column not in df_exploded.columns:
        name_column = "autors"

    available_extra = [c for c in extra_attributes if c in df_exploded.columns]
    available_list = [c for c in list_attributes if c in df_exploded.columns]

    name_counts: dict = {}
    extra_counts: dict = {c: {} for c in available_extra}
    list_values: dict = {c: {} for c in available_list}  # {author: {lower_kw: first-seen kw}}
    for _, row in df_exploded.iterrows():
        author_id = row[id_column]
        name_counts.setdefault(author_id, Counter())[row[name_column]] += 1
        for c in available_extra:
            val = row[c]
            if pd.notna(val):
                extra_counts[c].setdefault(author_id, Counter())[val] += 1
        for c in available_list:
            vals = row[c]
            if isinstance(vals, list) and vals:
                bucket = list_values[c].setdefault(author_id, {})
                for v in vals:
                    key = v.strip().lower()
                    if key and key not in bucket:
                        bucket[key] = v.strip()

    for author_id, counts in name_counts.items():
        node_attrs = {"display_name": counts.most_common(1)[0][0],
                      "has_orcid": bool(ORCID_PATTERN.match(str(author_id)))}
        for c in available_extra:
            author_counts = extra_counts[c].get(author_id)
            node_attrs[c] = author_counts.most_common(1)[0][0] if author_counts else None
        for c in available_list:
            node_attrs[c] = sorted(list_values[c].get(author_id, {}).values(), key=str.lower)
        G.add_node(author_id, **node_attrs)

    for article_id, group in df_exploded.groupby(ARTICLE_ID):
        authors_sorted = group.sort_values("author_level")
        authors_list = authors_sorted[id_column].tolist()
        levels = authors_sorted["author_level"].tolist()
        article_title = group["Article Title"].iloc[0]

        for i in range(len(authors_list)):
            for j in range(i + 1, len(authors_list)):
                a, b = authors_list[i], authors_list[j]
                if a == b:
                    # Same identity twice on one paper: WoS sometimes lists an author
                    # twice ("Hu, Zhixi; Hu, Zhixi"), or two spellings resolve to the
                    # same ORCID. Not a collaboration - and a self-loop would add 2
                    # to the node's degree ("N co-authors").
                    continue
                record = {"id": article_id, "title": article_title,
                          "level_a": levels[i], "level_b": levels[j]}
                if G.has_edge(a, b):
                    G[a][b]["weight"] += 1
                    G[a][b]["articles"].append(record)
                else:
                    G.add_edge(a, b, weight=1, articles=[record])

    for _, _, edata in G.edges(data=True):
        edata["article_titles"] = sorted({a["title"] for a in edata["articles"] if a.get("title")})

    return G


def create_institution_keyword_network(df: pd.DataFrame, group_column: str = "institution_department",
                                       node_attributes: tuple[str, ...] = ("institution", "department",
                                                                           "city", "country"),
                                       max_keyword_df: float = 0.2,
                                       min_shared_keywords: int = 1) -> nx.Graph:
    """Institution "potential collaboration" graph based on shared keywords.

    Two institutions are linked when at least one pair of their articles shares
    ``min_shared_keywords`` or more eligible keywords. A keyword is eligible only
    if it appears in at most ``max_keyword_df`` of articles: very common terms
    (e.g. "artificial intelligence" in an AI corpus) carry no signal.

    Edge 'weight' = number of distinct matched article pairs. Edges also carry
    'articles' (per-pair detail) and 'shared_keywords' (flat sorted union).

    Performance note: matching is pairwise over articles per keyword, so cost
    grows roughly quadratically with corpus size.
    """
    df = build_article_keyword_profiles(df)
    df = df[df[group_column].notna() & (df["keywords_norm"].apply(len) > 0)].copy()

    total_articles = len(df)
    doc_freq = compute_keyword_document_frequency(df)
    eligible_keywords = {kw for kw, freq in doc_freq.items()
                         if total_articles == 0 or (freq / total_articles) <= max_keyword_df}
    excluded_keywords = sorted(set(doc_freq) - eligible_keywords)
    log.info("Keyword matching pool: %d articles, %d unique normalized keywords; "
             "%d eligible; excluded as too generic (>%.0f%%): %s",
             total_articles, len(doc_freq), len(eligible_keywords), 100 * max_keyword_df,
             excluded_keywords)

    keyword_to_articles: dict[str, list] = {}
    for idx, row in df.iterrows():
        for kw in row["keywords_norm"]:
            if kw in eligible_keywords:
                keyword_to_articles.setdefault(kw, []).append(idx)

    groups = df[group_column].to_dict()
    article_ids = df[ARTICLE_ID].to_dict()

    # institution_pair -> {article_pair: {shared keywords}}
    matched_pairs: dict = {}
    for kw, idxs in keyword_to_articles.items():
        for i, j in combinations(idxs, 2):
            inst_i, inst_j = groups[i], groups[j]
            if inst_i == inst_j:
                continue  # only inter-institution matches count
            article_pair = tuple(sorted((article_ids[i], article_ids[j])))
            inst_pair = tuple(sorted((inst_i, inst_j)))
            matched_pairs.setdefault(inst_pair, {}).setdefault(article_pair, set()).add(kw)

    available_attrs = [c for c in node_attributes if c in df.columns]
    attr_counts: dict = {c: {} for c in available_attrs}
    for _, row in df.iterrows():
        key = row[group_column]
        for c in available_attrs:
            val = row[c]
            if pd.notna(val):
                attr_counts[c].setdefault(key, Counter())[val] += 1

    G = nx.Graph()
    for key in df[group_column].unique():
        node_attrs = {}
        for c in available_attrs:
            counts = attr_counts[c].get(key)
            node_attrs[c] = counts.most_common(1)[0][0] if counts else None
        G.add_node(key, **node_attrs)

    for (inst_a, inst_b), article_pairs in matched_pairs.items():
        qualifying = {ap: kws for ap, kws in article_pairs.items() if len(kws) >= min_shared_keywords}
        if not qualifying:
            continue
        articles_detail = [{"article_a": ap[0], "article_b": ap[1], "shared_keywords": sorted(kws)}
                           for ap, kws in qualifying.items()]
        G.add_edge(inst_a, inst_b, weight=len(qualifying), articles=articles_detail,
                   shared_keywords=sorted(set().union(*qualifying.values())))

    matched = {n for e in G.edges() for n in e}
    log.info("Institution nodes: %d total, %d with at least one match; %d edges",
             G.number_of_nodes(), len(matched), G.number_of_edges())
    return G


def create_grouped_network(df_exploded: pd.DataFrame, group_column: str) -> nx.Graph:
    """Co-occurrence graph at a coarser level (e.g. 'institution', 'country').

    Two groups are linked whenever authors from each appear on the same article.
    Not used by the current relations; kept for the planned institution/country networks.
    """
    df = df_exploded.dropna(subset=[group_column])
    G = nx.Graph()
    G.add_nodes_from(df[group_column].unique())

    for article_id, group in df.groupby(ARTICLE_ID):
        entities = group[group_column].unique().tolist()
        for a, b in combinations(entities, 2):
            if G.has_edge(a, b):
                G[a][b]["weight"] += 1
                G[a][b]["articles"].append(article_id)
            else:
                G.add_edge(a, b, weight=1, articles=[article_id])
    return G


def find_author_id(G: nx.Graph, display_name: str):
    """Node id for a display name (case-insensitive), or None."""
    target = display_name.strip().lower()
    for n, d in G.nodes(data=True):
        if d.get("display_name", "").strip().lower() == target:
            return n
    return None
