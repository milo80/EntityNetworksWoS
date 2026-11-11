"""Address parsing and institution attachment (author-level and article-level)."""

from __future__ import annotations

import logging
import re

import pandas as pd

from .authors import prepare_author_lists
from .keywords import parse_keyword_columns

log = logging.getLogger(__name__)

ARTICLE_ID = "UT (Unique WOS ID)"
DASH = "—"


def normalize_country(raw_country: str | None) -> str | None:
    """Collapse WoS's "TX 77807 USA"-style trailing segments to 'USA'."""
    if not raw_country:
        return raw_country
    if re.search(r"\bUSA\b", raw_country, re.IGNORECASE):
        return "USA"
    return raw_country.strip()


def _address_record(author_name: str, parts: list[str]) -> dict:
    return {
        "author_name": author_name,
        "institution": parts[0],
        "department": next((p for p in parts[1:] if p.lower().startswith("dept")), None),
        "city": parts[-2] if len(parts) >= 2 else None,
        "country": normalize_country(parts[-1]),
    }


def parse_address_block(address_str) -> list[dict]:
    """Parse a WoS 'Addresses' cell into per-author records.

    Format: "[Author A; Author B] Inst, Dept X, City, Country; [Author C] Inst2, City2, Country2".
    Department is set only when a segment starts with "Dept".

    Known limitation: North American addresses ("Bryan, TX 77807 USA") can put the
    state/province in the city slot. Institution and country are unaffected.
    """
    if not isinstance(address_str, str) or not address_str.strip():
        return []

    records = []
    for chunk in re.split(r";\s*(?=\[)", address_str):
        m = re.match(r"^\[([^\]]+)\]\s*(.+)$", chunk.strip())
        if not m:
            continue
        authors = [a.strip() for a in m.group(1).split(";")]
        parts = [p.strip() for p in m.group(2).split(",") if p.strip()]
        if not parts:
            continue
        records.extend(_address_record(author, parts) for author in authors)
    return records


def parse_reprint_address_block(reprint_str) -> list[dict]:
    """Parse a WoS 'Reprint Addresses' cell into corresponding-author records.

    Format: "Last, FI (corresponding author), Inst, Dept X, City, Country.; ...".
    Returns every record in listed order; pick_anchor_institution() chooses one.
    """
    if not isinstance(reprint_str, str) or not reprint_str.strip():
        return []

    records = []
    for entry in re.split(r";\s*", reprint_str.strip()):
        entry = entry.strip().rstrip(".").strip()
        if "(corresponding author)" not in entry:
            continue
        name_part, addr_part = entry.split("(corresponding author)", 1)
        parts = [p.strip() for p in addr_part.lstrip(", ").split(",") if p.strip()]
        if not parts:
            continue
        records.append(_address_record(name_part.strip().rstrip(","), parts))
    return records


def is_university(institution_name: str | None) -> bool:
    """Heuristic: WoS abbreviates universities as 'Univ' (misses e.g. 'MIT')."""
    return bool(institution_name) and "univ" in institution_name.lower()


def pick_anchor_institution(records: list[dict]) -> dict | None:
    """First university-looking record, else the first record, else None."""
    if not records:
        return None
    for r in records:
        if is_university(r["institution"]):
            return r
    return records[0]


def _institution_department(row) -> str | None:
    if pd.notna(row["department"]):
        return f"{row['institution']} {DASH} {row['department']}"
    return row["institution"]


def enrich_with_institution_data(df_exploded: pd.DataFrame,
                                 address_column: str = "Addresses") -> pd.DataFrame:
    """Attach institution/department/city/country to each author-article row.

    Matched by author name within the same article (affiliations vary per paper).
    Also adds 'institution_department' ("Inst - Dept"), since department names
    repeat across institutions.

    Known issue (see docs/design-notes.md): addresses should ultimately be
    modelled per article-institution rather than per exploded author row.
    """
    # The exploded df has duplicate index labels (one per author of an article);
    # .loc assignment on a duplicate label would overwrite every co-author's row.
    df_exploded = df_exploded.reset_index(drop=True)

    for col in ["institution", "department", "city", "country"]:
        df_exploded[col] = None

    for _, group in df_exploded.groupby(ARTICLE_ID):
        records = parse_address_block(group[address_column].iloc[0])
        name_lookup = {r["author_name"].strip().lower(): r for r in records}
        for idx, row in group.iterrows():
            match = name_lookup.get(str(row["autors"]).strip().lower())
            if match:
                for col in ("institution", "department", "city", "country"):
                    df_exploded.loc[idx, col] = match[col]

    df_exploded["institution_department"] = df_exploded.apply(_institution_department, axis=1)

    total = len(df_exploded)
    matched = df_exploded["institution"].notna().sum()
    log.info("Matched institution for %d/%d author-article rows (%.0f%%); "
             "%d institutions, %d institution+department pairs, %d countries",
             matched, total, 100 * matched / total if total else 0,
             df_exploded["institution"].nunique(),
             df_exploded["institution_department"].nunique(),
             df_exploded["country"].nunique())
    return df_exploded


def prepare_article_institution_data(df: pd.DataFrame, address_column: str = "Reprint Addresses",
                                     doc_types: tuple[str, ...] = ("Article", "Review"),
                                     attr_columns: tuple[str, ...] = ("Article Title", "Source Title",
                                                                      "Publication Year"),
                                     ) -> pd.DataFrame:
    """Article-level df for the institution keyword relation (one row per article).

    Each article is anchored to its corresponding author's institution (from
    Reprint Addresses, preferring a university), and gets parsed keyword lists.
    Only ``doc_types`` are kept.
    """
    before = len(df)
    df = df[df["Document Type"].isin(doc_types)].copy()
    log.info("Filtered to %s: %d -> %d articles", doc_types, before, len(df))

    df = prepare_author_lists(df)

    anchors = df[address_column].apply(parse_reprint_address_block).apply(pick_anchor_institution)
    for col in ("institution", "department", "city", "country"):
        df[col] = anchors.apply(lambda r, c=col: r[c] if r else None)
    df["institution_department"] = df.apply(_institution_department, axis=1)

    resolved = df["institution"].notna().sum()
    log.info("Resolved corresponding-author institution for %d/%d articles (%.0f%%); "
             "%d institutions, %d institution+department pairs, %d countries",
             resolved, len(df), 100 * resolved / len(df) if len(df) else 0,
             df["institution"].nunique(), df["institution_department"].nunique(),
             df["country"].nunique())

    df = parse_keyword_columns(df)

    keep_cols = [ARTICLE_ID, "autors_list", "author_keywords", "keywords_plus",
                 "institution", "department", "city", "country",
                 "institution_department", *attr_columns]
    return df[keep_cols]
