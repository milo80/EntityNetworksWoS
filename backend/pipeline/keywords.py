"""Keyword parsing, normalization and document frequency."""

from __future__ import annotations

from collections import Counter

import pandas as pd

KEYWORD_SOURCE_COLUMNS = ("Author Keywords", "Keywords Plus")


def parse_keyword_columns(df: pd.DataFrame,
                          columns: tuple[str, ...] = KEYWORD_SOURCE_COLUMNS) -> pd.DataFrame:
    """Split semicolon-separated keyword fields into list columns.

    "AI ethics; Bibliometrics" -> ["AI ethics", "Bibliometrics"]. Adds one
    snake_case list column per input column ('author_keywords', 'keywords_plus');
    missing cells become []. Keywords are article-level: every co-author shares
    the same list.
    """
    df = df.copy()
    for col in columns:
        if col not in df.columns:
            continue
        list_col = col.lower().replace(" ", "_")
        df[list_col] = df[col].apply(
            lambda v: [kw.strip() for kw in str(v).split(";") if kw.strip()] if pd.notna(v) else []
        )
    return df


def normalize_keyword(kw: str) -> str:
    """Lowercase and fold hyphens to spaces ('ARTIFICIAL-INTELLIGENCE' == 'artificial intelligence')."""
    return str(kw).strip().lower().replace("-", " ")


def build_article_keyword_profiles(df: pd.DataFrame,
                                   keyword_columns: tuple[str, ...] = ("author_keywords", "keywords_plus"),
                                   ) -> pd.DataFrame:
    """Add 'keywords_norm': sorted, deduplicated normalized keywords per article."""
    df = df.copy()

    def union_normalized(row):
        kws = set()
        for col in keyword_columns:
            for kw in (row.get(col) or []):
                norm = normalize_keyword(kw)
                if norm:
                    kws.add(norm)
        return sorted(kws)

    df["keywords_norm"] = df.apply(union_normalized, axis=1)
    return df


def compute_keyword_document_frequency(df: pd.DataFrame,
                                       keyword_column: str = "keywords_norm") -> Counter:
    """Number of articles mentioning each normalized keyword at least once."""
    doc_freq: Counter = Counter()
    for kws in df[keyword_column]:
        doc_freq.update(set(kws))
    return doc_freq
