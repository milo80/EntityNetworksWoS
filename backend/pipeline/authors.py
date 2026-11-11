"""Author lists, mega-paper filtering, author explode and identity resolution."""

from __future__ import annotations

import hashlib
import logging

import pandas as pd

log = logging.getLogger(__name__)

AUTHOR_NAMES_COLUMN = "Author Full Names"


def prepare_author_lists(df: pd.DataFrame, column_name: str = AUTHOR_NAMES_COLUMN,
                         report: bool = False) -> pd.DataFrame:
    """Ensure the article-level 'autors_list' column exists.

    Splits "Smith, J; Doe, A" -> ["Smith, J", "Doe, A"]. Idempotent: an existing
    'autors_list' is left untouched, so downstream steps can call this as a guard.
    report=True logs authors-per-article statistics (useful for choosing the
    mega-paper threshold).
    """
    df = df.copy()
    if "autors_list" not in df.columns:
        df["autors_list"] = df[column_name].str.split(";").apply(
            lambda x: [name.strip() for name in x] if isinstance(x, list) else []
        )

    if report:
        counts = df["autors_list"].apply(len)
        log.info("Total articles: %d", len(df))
        log.info("Authors-per-article distribution:\n%s", counts.describe())
        log.info("95th / 99th percentile: %s / %s", counts.quantile(0.95), counts.quantile(0.99))
        log.info("Articles with 15+ authors: %d; 20+ authors: %d",
                 (counts >= 15).sum(), (counts >= 20).sum())
    return df


def filter_out_mega_papers(df: pd.DataFrame, max_authors: int = 15) -> pd.DataFrame:
    """Drop articles with more than ``max_authors`` authors.

    Large consensus/guideline papers form near-complete cliques that dominate
    degree rankings without reflecting real bilateral collaboration. Runs on the
    article-level df, so it gates every relation, not only the author network.
    """
    df = prepare_author_lists(df)
    before = len(df)
    filtered = df[df["autors_list"].apply(len) <= max_authors].copy()
    log.info("Filtered out mega-papers (> %d authors): %d -> %d articles",
             max_authors, before, len(filtered))
    return filtered


def extract_authors_with_metadata(df: pd.DataFrame) -> pd.DataFrame:
    """Explode the article-level df to one row per (article, author).

    Adds 'autors' (author name), 'author_level' (0-based position on the paper)
    and 'total_authors'. All article columns are kept.
    """
    df = prepare_author_lists(df)
    df["author_level_list"] = df["autors_list"].apply(lambda x: list(range(len(x))))
    df["total_authors"] = df["autors_list"].apply(len)

    df_exploded = df.explode(["autors_list", "author_level_list"])
    df_exploded = df_exploded.rename(columns={"autors_list": "autors",
                                              "author_level_list": "author_level"})
    df_exploded = df_exploded[df_exploded["autors"].notna()]
    df_exploded = df_exploded[df_exploded["autors"] != ""]
    return df_exploded


def build_orcid_lookup(df_exploded: pd.DataFrame, orcid_column: str = "ORCIDs") -> dict[str, str]:
    """Build a lowercase-name -> ORCID lookup from the WoS ORCIDs column.

    WoS format: "Last, First/0000-0000-0000-0000; ...". Scanned across the whole
    dataset, since an author's ORCID may only be listed on some of their papers.
    """
    name_to_orcid: dict[str, str] = {}
    if orcid_column not in df_exploded.columns:
        return name_to_orcid

    for raw in df_exploded[orcid_column].dropna().unique():
        for entry in str(raw).split(";"):
            entry = entry.strip()
            if "/" not in entry:
                continue
            name_part, orcid_part = entry.rsplit("/", 1)
            name_key = name_part.strip().lower()
            orcid_part = orcid_part.strip()
            if name_key and orcid_part:
                name_to_orcid[name_key] = orcid_part
    return name_to_orcid


def synthetic_author_code(name: str) -> str:
    """Stable stand-in ID for authors without an ORCID: 'LOCAL-' + 12-char sha1."""
    digest = hashlib.sha1(str(name).strip().lower().encode("utf-8")).hexdigest()[:12]
    return f"LOCAL-{digest}"


def resolve_author_ids(df_exploded: pd.DataFrame, orcid_column: str = "ORCIDs") -> pd.DataFrame:
    """Add 'display_name' (name as printed) and 'author_id' (ORCID, else LOCAL code).

    The id is never a raw name; everything user-facing reads 'display_name'.
    """
    name_to_orcid = build_orcid_lookup(df_exploded, orcid_column)

    def resolve(name):
        orcid = name_to_orcid.get(str(name).strip().lower())
        return orcid if orcid else synthetic_author_code(name)

    df_exploded = df_exploded.copy()
    df_exploded["display_name"] = df_exploded["autors"]
    df_exploded["author_id"] = df_exploded["autors"].apply(resolve)

    resolved = df_exploded["author_id"].isin(name_to_orcid.values()).sum()
    total = len(df_exploded)
    log.info("ORCID resolution: %d/%d author-article rows resolved (%.0f%%); "
             "%d unique identities vs %d unique raw names",
             resolved, total, 100 * resolved / total if total else 0,
             df_exploded["author_id"].nunique(), df_exploded["autors"].nunique())
    return df_exploded
