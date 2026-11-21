"""The article rows of a dataset ("records"), as the Records tab shows them.

One record per row of the uploaded exports, in the order the networks read
them, with duplicates kept. Next to the export's own columns, each record gets
the values the networks derive, computed by the networks' own code so a filter
matches what a network matched:

- "Institutions (parsed)": the "Institution (all authors)" node names, from
  "Addresses" (custom._all_institutions).
- "Keywords (normalized)": "Author Keywords" and "Keywords Plus" together,
  normalized like the keyword links (keywords.normalize_keyword).

Pure function (DataFrame -> JSON-safe dicts); the worker stores the result.
"""

from __future__ import annotations

import math
from typing import Any

import pandas as pd

from .custom import ENTITIES, LINKS
from .keywords import normalize_keyword

INSTITUTIONS_PARSED = "Institutions (parsed)"
KEYWORDS_NORMALIZED = "Keywords (normalized)"
DERIVED_COLUMNS = (INSTITUTIONS_PARSED, KEYWORDS_NORMALIZED)
KEYWORD_COLUMNS = ("Author Keywords", "Keywords Plus", KEYWORDS_NORMALIZED)
"""Columns whose items "has item" normalizes like the keyword networks do."""
ITEM_SEPARATOR = "; "


def _cell(value: Any) -> str | int | float | None:
    """A JSON-safe cell, full length; empty and missing -> None."""
    if value is None:
        return None
    if hasattr(value, "item"):  # numpy scalar
        value = value.item()
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return None
        return int(value) if value.is_integer() else value
    if isinstance(value, int):
        return value
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    text = _clean(str(value)).strip()
    return text or None


def _clean(text: str) -> str:
    """PostgreSQL text and JSONB can't hold NUL characters; WoS text never needs them."""
    return text.replace("\x00", "")


def derived_columns(columns: list[str]) -> list[str]:
    """The derived columns an export with these columns gets, in display order."""
    out = []
    if all(c in columns for c in ENTITIES["institution"].columns):
        out.append(INSTITUTIONS_PARSED)
    if any(c in columns for c in LINKS["keywords"].columns):
        out.append(KEYWORDS_NORMALIZED)
    return out


def _joined(items: list[str]) -> str | None:
    return ITEM_SEPARATOR.join(items) if items else None


def dataset_records(df: pd.DataFrame) -> list[dict[str, Any]]:
    """One dict per row (column -> value), empty values left out."""
    articles = df.reset_index(drop=True)
    columns = [_clean(str(c)) for c in articles.columns]
    supported = derived_columns(columns)
    derived: dict[str, list[str | None]] = {}
    if INSTITUTIONS_PARSED in supported:
        institutions = ENTITIES["institution"].extract(articles)
        derived[INSTITUTIONS_PARSED] = [_joined([o[1] for o in occ]) for occ in institutions]
    if KEYWORDS_NORMALIZED in supported:
        keywords = LINKS["keywords"].values(articles)
        derived[KEYWORDS_NORMALIZED] = [
            _joined(list(dict.fromkeys(n for kw in kws if (n := normalize_keyword(kw)))))
            for kws in keywords
        ]
    records = []
    for i, row in enumerate(articles.itertuples(index=False)):
        record = {
            c: v for c, raw in zip(columns, row, strict=True) if (v := _cell(raw)) is not None
        }
        for name, values in derived.items():
            if (value := values[i]) is not None:
                record[name] = _clean(value)
        records.append(record)
    return records
