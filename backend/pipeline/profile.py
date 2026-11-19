"""Profile of an uploaded WoS dataset: schema, a sample, and basic statistics.

Shown to users before they build a network, so they can see what the data
contains. Pure function (DataFrame -> JSON-safe dict); computed by the worker.
"""

from __future__ import annotations

import logging
import math
from collections import Counter
from typing import Any

import pandas as pd

from .authors import prepare_author_lists
from .custom import ENTITIES, LINKS, MODELS
from .institutions import ARTICLE_ID, parse_reprint_address_block, pick_anchor_institution
from .keywords import normalize_keyword, parse_keyword_columns

PROFILE_VERSION = 3
"""Bump when the profile gains or changes content: the worker re-profiles older ones."""
SAMPLE_ROWS = 10
MAX_CELL_CHARS = 200
TOP_N = 10
MEGA_PAPER_AUTHORS = 15

log = logging.getLogger(__name__)


def _json_value(value: Any) -> Any:
    """Make a pandas/numpy cell JSON-safe (NaN -> None, numpy scalars -> Python)."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if hasattr(value, "item"):  # numpy scalar
        value = value.item()
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    if isinstance(value, str) and len(value) > MAX_CELL_CHARS:
        return value[:MAX_CELL_CHARS] + "…"
    return value


def _column_type(series: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(series):
        return "boolean"
    if pd.api.types.is_numeric_dtype(series):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "date"
    return "text"


def _non_empty(series: pd.Series) -> pd.Series:
    s = series.dropna()
    if s.dtype == object:
        s = s[s.astype(str).str.strip() != ""]
    return s


def _schema(df: pd.DataFrame) -> list[dict]:
    columns = []
    for name in df.columns:
        values = _non_empty(df[name])
        columns.append(
            {
                "name": str(name),
                "type": _column_type(df[name]),
                "non_empty": len(values),
                "non_empty_pct": _pct(len(values), len(df)),
                "distinct": int(values.astype(str).nunique()),
                "example": _json_value(values.iloc[0]) if len(values) else None,
            }
        )
    return columns


def _pct(part, total) -> float:
    return round(100 * float(part) / total, 1) if total else 0.0


def _counts(counter: Counter, n: int = TOP_N) -> list[dict]:
    return [{"value": str(k), "count": int(c)} for k, c in counter.most_common(n)]


def _describe(values: pd.Series) -> dict | None:
    if values.empty:
        return None
    return {
        "min": int(values.min()),
        "median": float(values.median()),
        "mean": round(float(values.mean()), 2),
        "max": int(values.max()),
    }


def _author_occurrences(authors: pd.Series) -> list[list[tuple[str, str]]]:
    """Authors per article by name (case-insensitive, first-seen spelling). The
    network's ORCID-based identity takes ~12 s on 3,000 articles; names take ~0.1 s."""
    shown: dict[str, str] = {}
    out = []
    for names in authors:
        row = []
        for name in names:
            name = name.strip()
            if name:
                key = name.lower()
                row.append((key, shown.setdefault(key, name)))
        out.append(row)
    return out


def _catalog(df: pd.DataFrame, authors: pd.Series | None) -> list[dict]:
    """Top values of every node type a custom network can use (custom.ENTITIES),
    counted in articles, so users can see what each would contain before building."""
    entries = []
    for key, spec in ENTITIES.items():
        if spec.granularity == "article" or not all(c in df.columns for c in spec.columns):
            continue
        try:
            if key == "author":
                if authors is None:
                    continue
                per_article = _author_occurrences(authors)
            else:
                per_article = [[(o[0], o[1]) for o in occ] for occ in spec.extract(df)]
        except Exception:
            log.exception("Profile: node catalog entry %r failed", key)
            continue
        counter: Counter = Counter()
        shown: dict[str, str] = {}
        for row in per_article:
            # Once per article, in first-seen order (a set would make tie order
            # depend on the hash seed).
            seen: set[str] = set()
            for eid, name in row:
                if eid not in seen:
                    seen.add(eid)
                    counter[eid] += 1
                    shown.setdefault(eid, name)
        entries.append(
            {
                "key": key,
                "label": spec.label,
                "granularity": spec.granularity,
                "distinct": len(counter),
                "articles_with_pct": _pct(sum(1 for row in per_article if row), len(df)),
                "top": [
                    {"value": shown[eid], "count": int(c)} for eid, c in counter.most_common(TOP_N)
                ],
            }
        )
    return entries


def _link_catalog(df: pd.DataFrame) -> list[dict]:
    """Every field a custom network can link by (custom.LINKS): how many articles
    have it, and what it contains - top items for list fields (normalized as word
    matching compares them), typical length for text fields."""
    entries = []
    for key, spec in LINKS.items():
        if not all(c in df.columns for c in spec.columns if spec.kind != "list") or not any(
            c in df.columns for c in spec.columns
        ):
            continue
        entry: dict[str, Any] = {
            "key": key,
            "label": spec.label,
            "kind": spec.kind,
            "models": [MODELS[m] for m in spec.models] if spec.kind != "same_article" else [],
        }
        try:
            values = spec.values(df)
        except Exception:
            log.exception("Profile: link catalog entry %r failed", key)
            continue
        entry["articles_with_pct"] = _pct(sum(1 for vs in values if vs), len(df))
        if spec.kind == "list":
            counter: Counter = Counter()
            for vs in values:
                counter.update(list(dict.fromkeys(n for v in vs if (n := normalize_keyword(v)))))
            entry["distinct"] = len(counter)
            # Same column as a node type: its values are that node card's, so no
            # second top list.
            same = [k for k, e in ENTITIES.items() if set(e.columns) == set(spec.columns)]
            entry["same_as_node"] = same[0] if same else None
            entry["top"] = [] if same else _counts(counter)
        elif spec.kind == "string":
            words = [len(vs[0].split()) for vs in values if vs]
            entry["median_words"] = int(pd.Series(words).median()) if words else None
        entries.append(entry)
    return entries


def profile_dataset(df: pd.DataFrame) -> dict:
    """Schema + sample + statistics for an article-level WoS dataframe."""
    stats: dict[str, Any] = {"articles": len(df), "columns": len(df.columns)}

    if ARTICLE_ID in df.columns:
        ids = _non_empty(df[ARTICLE_ID]).astype(str)
        stats["unique_article_ids"] = int(ids.nunique())
        stats["duplicate_article_ids"] = int(len(ids) - ids.nunique())

    if "Publication Year" in df.columns:
        years = pd.to_numeric(df["Publication Year"], errors="coerce").dropna().astype(int)
        stats["publication_years"] = {
            "min": int(years.min()) if len(years) else None,
            "max": int(years.max()) if len(years) else None,
            "per_year": [
                {"value": str(y), "count": int(c)} for y, c in sorted(Counter(years).items())
            ],
        }

    if "Document Type" in df.columns:
        stats["document_types"] = _counts(Counter(_non_empty(df["Document Type"]).astype(str)))

    authors = None
    if "Author Full Names" in df.columns:
        authors = prepare_author_lists(df)["autors_list"]
        per_article = authors.apply(len)
        names = Counter(name.strip().lower() for names in authors for name in names if name.strip())
        stats["authors"] = {
            "mentions": int(per_article.sum()),
            "unique_names": len(names),
            "per_article": _describe(per_article),
            "articles_over_mega_threshold": int((per_article > MEGA_PAPER_AUTHORS).sum()),
            "mega_threshold": MEGA_PAPER_AUTHORS,
        }

    if "ORCIDs" in df.columns:
        with_orcid = len(_non_empty(df["ORCIDs"]))
        stats["articles_with_orcid_pct"] = _pct(with_orcid, len(df))

    keyword_cols = [c for c in ("Author Keywords", "Keywords Plus") if c in df.columns]
    if keyword_cols:
        parsed = parse_keyword_columns(df[keyword_cols])
        keywords: dict[str, Any] = {}
        for col in keyword_cols:
            lists = parsed[col.lower().replace(" ", "_")]
            # dict.fromkeys: dedupe per article in first-seen order (a set would make tie order
            # depend on the hash seed).
            counter = Counter(normalize_keyword(k) for kws in lists for k in dict.fromkeys(kws))
            keywords[col.lower().replace(" ", "_")] = {
                "articles_with_pct": _pct((lists.apply(len) > 0).sum(), len(df)),
                "unique": len(counter),
                "top": _counts(counter),
            }
        stats["keywords"] = keywords

    if "Reprint Addresses" in df.columns:
        anchors = (
            df["Reprint Addresses"]
            .apply(parse_reprint_address_block)
            .apply(pick_anchor_institution)
        )
        stats["corresponding_author"] = {"resolved_pct": _pct(anchors.notna().sum(), len(df))}

    stats["catalog"] = _catalog(df, authors)
    stats["link_catalog"] = _link_catalog(df)

    sample = df.head(SAMPLE_ROWS)
    return {
        "version": PROFILE_VERSION,
        "schema": _schema(df),
        "sample": {
            "columns": [str(c) for c in df.columns],
            "rows": [[_json_value(v) for v in row] for row in sample.itertuples(index=False)],
        },
        "stats": stats,
    }
