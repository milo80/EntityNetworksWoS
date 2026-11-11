"""End-to-end relation builders: article-level WoS df -> network JSON dict.

These are the entry points the CLI and (later) the API worker call. Default
parameters reproduce the networks produced by the legacy demo.
"""

from __future__ import annotations

from dataclasses import dataclass

import networkx as nx
import pandas as pd

from .authors import (
    extract_authors_with_metadata,
    filter_out_mega_papers,
    prepare_author_lists,
    resolve_author_ids,
)
from .export import graph_to_network
from .institutions import enrich_with_institution_data, prepare_article_institution_data
from .keywords import parse_keyword_columns
from .networks import create_author_network, create_institution_keyword_network


@dataclass(frozen=True)
class AuthorNetworkParams:
    top_n: int = 700
    team_attribute: str | None = "country"
    max_team_categories: int = 22
    min_team_size: int = 2
    node_attrs: tuple[str, ...] = ("institution", "department", "city",
                                   "author_keywords", "keywords_plus")
    edge_attrs: tuple[str, ...] = ("article_titles",)


@dataclass(frozen=True)
class InstitutionKeywordParams:
    group_column: str = "institution_department"
    max_keyword_df: float = 0.12
    min_shared_keywords: int = 3
    top_n: int = 150
    team_attribute: str | None = "country"
    max_team_categories: int = 12
    min_team_size: int = 2
    node_attrs: tuple[str, ...] = ("institution", "department", "city")
    edge_attrs: tuple[str, ...] = ("shared_keywords",)


def prepare_articles(df: pd.DataFrame, max_authors: int = 15) -> pd.DataFrame:
    """Shared article-level preparation: author lists + mega-paper filter."""
    df = prepare_author_lists(df, report=True)
    return filter_out_mega_papers(df, max_authors=max_authors)


def build_author_graph(articles: pd.DataFrame) -> nx.Graph:
    """Full (unsampled) co-authorship graph from prepared articles."""
    df_exploded = extract_authors_with_metadata(articles)
    df_exploded = resolve_author_ids(df_exploded)
    df_exploded = enrich_with_institution_data(df_exploded)
    df_exploded = parse_keyword_columns(df_exploded)
    return create_author_network(df_exploded)


def author_network(articles: pd.DataFrame, params: AuthorNetworkParams | None = None) -> dict:
    """Co-authorship network JSON (edge type 'collaborates_with')."""
    params = params or AuthorNetworkParams()
    G = build_author_graph(articles)
    return graph_to_network(
        G, top_n=params.top_n, edge_type="collaborates_with", role_suffix="co-authors",
        team_attribute=params.team_attribute, max_team_categories=params.max_team_categories,
        min_team_size=params.min_team_size, node_attrs=params.node_attrs,
        edge_attrs=params.edge_attrs,
    )


def institution_keyword_network(articles: pd.DataFrame,
                                params: InstitutionKeywordParams | None = None) -> dict:
    """Institution shared-keyword network JSON (edge type 'shares_keywords_with')."""
    params = params or InstitutionKeywordParams()
    df_inst = prepare_article_institution_data(articles)
    G = create_institution_keyword_network(
        df_inst, group_column=params.group_column, max_keyword_df=params.max_keyword_df,
        min_shared_keywords=params.min_shared_keywords,
    )
    return graph_to_network(
        G, top_n=params.top_n, edge_type="shares_keywords_with",
        role_suffix="keyword-linked institutions", team_attribute=params.team_attribute,
        max_team_categories=params.max_team_categories, min_team_size=params.min_team_size,
        node_attrs=params.node_attrs, edge_attrs=params.edge_attrs,
    )


RELATIONS = {
    "author": (author_network, AuthorNetworkParams),
    "institution_keywords": (institution_keyword_network, InstitutionKeywordParams),
}
