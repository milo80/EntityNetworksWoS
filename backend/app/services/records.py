"""Filtering, sorting and paging a dataset's records (pipeline.records) in SQL.

The rows are JSONB objects (column -> value, empty ones left out), so every
filter reads ``data ->> column``. The rules match the explorer's attribute
search: ";" separates alternatives in a filter (OR), filters combine with AND,
terms are trimmed and empty ones dropped. The text operators ignore case and
accents: the cell and the term both go through ``fold`` (``lower(unaccent(...))``)
in SQL, so they are folded by the same function.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any, cast

from psycopg.errors import QueryCanceled
from sqlalchemy import (
    ColumnElement,
    Select,
    Text,
    any_,
    case,
    func,
    literal,
    not_,
    select,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from pipeline.profile import RECORDS_SINCE_VERSION
from pipeline.records import KEYWORD_COLUMNS, derived_columns

from ..models import Dataset, DatasetRecord
from ..schemas.api import (
    RECORDS_PAGE_SIZE,
    ProfileStatus,
    RecordColumnOut,
    RecordFilter,
    RecordOut,
    RecordsPageOut,
)

SPACES = " \t\r\n"
"""Trimmed around list items (Python's str.strip() in the pipeline)."""


def records_state(dataset: Dataset) -> tuple[ProfileStatus, str | None]:
    """'ready' once the dataset's records are stored; else the profile's status.

    A dataset profiled before records existed is 'pending' until the worker's
    profile refresh stores them, or 'failed' if that refresh failed.
    """
    if dataset.profile_status != "ready":
        return cast(ProfileStatus, dataset.profile_status), dataset.profile_error
    profile = dataset.profile or {}
    if int(profile.get("version") or 0) >= RECORDS_SINCE_VERSION:
        return "ready", None
    if int(profile.get("refresh_failed_version") or 0) >= RECORDS_SINCE_VERSION:
        return "failed", "The records could not be read from these files (see server logs)"
    return "pending", None


def record_columns(dataset: Dataset) -> list[RecordColumnOut]:
    """The export's columns (in file order), then the derived ones it supports."""
    profile = dataset.profile or {}
    types = {c["name"]: c.get("type", "text") for c in profile.get("schema", [])}
    names = list(profile.get("sample", {}).get("columns", types))
    own = [RecordColumnOut(name=n, derived=False, type=types.get(n, "text")) for n in names]
    extra = [
        RecordColumnOut(name=n, derived=True, type="text")
        for n in derived_columns(names)
        if n not in names
    ]
    return own + extra


MAX_TERMS_PER_FILTER = 50
MAX_TERMS = 200
STATEMENT_TIMEOUT_MS = 5000
"""A records query that takes longer is cancelled (RecordsQueryTooSlow)."""


class RecordsQueryError(ValueError):
    """The filters can't be run as asked; the message is shown to the user."""


def terms(value: str) -> list[str]:
    """'a; B ;; A' -> ['a', 'B'] (as visibility.parseAttrRows in the UI, deduplicated).

    Trimmed but not lower-cased: SQL folds them (``fold``), as it folds the cells.
    """
    unique: dict[str, str] = {}
    for part in value.split(";"):
        if t := part.strip():
            unique.setdefault(t.casefold(), t)
    return list(unique.values())


def check_filter_size(filters: list[RecordFilter]) -> None:
    """Cap the work a request can ask for: every term is a scan of every record."""
    counts = [len(terms(f.value)) for f in filters]
    if any(n > MAX_TERMS_PER_FILTER for n in counts):
        raise RecordsQueryError(
            f'A filter can have at most {MAX_TERMS_PER_FILTER} terms separated by ";".'
        )
    if sum(counts) > MAX_TERMS:
        raise RecordsQueryError(f"The filters can have at most {MAX_TERMS} terms in all.")


def _text(column: str) -> ColumnElement[Any]:
    return DatasetRecord.data[column].astext


TEXT_OPERATORS = ("contains", "not_contains", "has_item")


def fold(value: ColumnElement[Any], column: str) -> ColumnElement[Any]:
    """Case and accents ignored ("Í", "İ", "ì" -> "i"); keyword columns also treat
    hyphens as spaces, like pipeline.keywords.normalize_keyword. Unlike it, typographic
    dashes (‐ ‑ ‒ – — ― − and the soft hyphen) count as hyphens too: unaccent turns them
    into "-" first. Applied to cells and terms alike, so both sides are folded by the
    same function."""
    folded = func.lower(func.unaccent(value))
    return func.replace(folded, "-", " ") if column in KEYWORD_COLUMNS else folded


def _fold_terms(db: Session, filters: list[RecordFilter]) -> list[list[str]]:
    """Each filter's terms, folded by PostgreSQL in one query (as the cells are).

    Folded beforehand so that the filters compare constants: PostgreSQL would
    otherwise unaccent every term again for every record. A term that folds to
    nothing (a lone accent) is dropped, as empty terms are.
    """
    per_filter = [terms(f.value) if f.op in TEXT_OPERATORS else [] for f in filters]
    exprs = [fold(literal(t, Text), f.column) for f, ts in zip(filters, per_filter) for t in ts]
    folded: Iterator[str] = iter(db.execute(select(*exprs)).one() if exprs else ())
    return [[t for t in dict.fromkeys(next(folded) for _ in ts) if t] for ts in per_filter]


def _like_escape(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _contains(column: str, folded: list[str]) -> ColumnElement[bool]:
    """Substring of the folded cell (also used, negated, by "does not contain").

    LIKE ANY folds the cell once per record, whatever the number of terms."""
    cell = fold(func.coalesce(_text(column), ""), column)
    patterns = [f"%{_like_escape(t)}%" for t in folded]
    return cell.like(any_(literal(patterns, ARRAY(Text))))


def _has_item(column: str, folded: list[str]) -> ColumnElement[bool]:
    """A trimmed ";"-separated item equals a term, both folded."""
    items = func.unnest(func.string_to_array(_text(column), ";")).column_valued("item")
    item = fold(func.btrim(items, SPACES), column)
    return select(literal(1)).where(item == any_(literal(folded, ARRAY(Text)))).exists()


def _condition(f: RecordFilter, folded: list[str]) -> ColumnElement[bool] | None:
    if f.op == "is_empty":
        return _text(f.column).is_(None)
    if f.op == "not_empty":
        return _text(f.column).is_not(None)
    if not folded:
        return None  # nothing to match: the row is ignored, as in the explorer
    if f.op == "contains":
        return _contains(f.column, folded)
    if f.op == "not_contains":
        return not_(_contains(f.column, folded))
    return _has_item(f.column, folded)


def _sort_key(column: RecordColumnOut) -> ColumnElement[Any]:
    if column.type == "number":
        value = DatasetRecord.data[column.name]
        return case(
            (func.jsonb_typeof(value) == "number", value.as_float()),
            else_=None,
        )
    return func.lower(_text(column.name))


def query_records(
    db: Session,
    dataset: Dataset,
    *,
    page: int,
    filters: list[RecordFilter],
    sort: str | None,
    descending: bool,
    columns: list[str],
) -> RecordsPageOut:
    status, error = records_state(dataset)
    all_columns = record_columns(dataset)
    by_name = {c.name: c for c in all_columns}
    ignored = list(dict.fromkeys(f.column for f in filters if f.column not in by_name))
    empty = RecordsPageOut(
        status=status,
        error=error,
        columns=all_columns if status == "ready" else [],
        total=0,
        matching=0,
        page=page,
        page_size=RECORDS_PAGE_SIZE,
        rows=[],
        ignored_filter_columns=ignored if status == "ready" else [],
    )
    if status != "ready":
        return empty

    check_filter_size(filters)
    known = [f for f in filters if f.column in by_name]
    own = DatasetRecord.dataset_id == dataset.id
    # Bounded: this transaction's statements are cancelled after the timeout.
    db.execute(text(f"SET LOCAL statement_timeout = {int(STATEMENT_TIMEOUT_MS)}"))
    try:
        conditions = [
            c
            for f, folded in zip(known, _fold_terms(db, known))
            if (c := _condition(f, folded)) is not None
        ]
        return _page(db, empty, own, conditions, by_name, page, sort, descending, columns)
    except OperationalError as exc:
        if isinstance(exc.orig, QueryCanceled):
            db.rollback()
            raise RecordsQueryError(
                "These filters take too long on this dataset. Use fewer or longer terms."
            ) from exc
        raise


def _page(
    db: Session,
    empty: RecordsPageOut,
    own: ColumnElement[bool],
    conditions: list[ColumnElement[bool]],
    by_name: dict[str, RecordColumnOut],
    page: int,
    sort: str | None,
    descending: bool,
    columns: list[str],
) -> RecordsPageOut:
    total = db.scalar(select(func.count()).where(own)) or 0
    # One scan for the page and the matching count (the window counts every match).
    matches = func.count().over() if conditions else literal(total)
    query: Select = select(DatasetRecord.position, DatasetRecord.data, matches).where(
        own, *conditions
    )
    if sort in by_name:
        key = _sort_key(by_name[sort])
        query = query.order_by(key.desc().nulls_last() if descending else key.asc().nulls_last())
    query = query.order_by(DatasetRecord.position)
    query = query.offset((page - 1) * RECORDS_PAGE_SIZE).limit(RECORDS_PAGE_SIZE)

    wanted = [c for c in columns if c in by_name] or list(by_name)
    found = db.execute(query).all()
    rows = [
        RecordOut(index=position, values={c: data[c] for c in wanted if c in data})
        for position, data, _ in found
    ]
    if found:
        matching = int(found[0][2])
    elif conditions and page > 1:  # past the last page: no row carries the count
        matching = db.scalar(select(func.count()).where(own, *conditions)) or 0
    else:
        matching = 0 if conditions else total
    return empty.model_copy(update={"total": total, "matching": matching, "rows": rows})


def get_record(db: Session, dataset: Dataset, index: int) -> RecordOut | None:
    data = db.scalar(
        select(DatasetRecord.data).where(
            DatasetRecord.dataset_id == dataset.id, DatasetRecord.position == index
        )
    )
    return None if data is None else RecordOut(index=index, values=data)


__all__ = [
    "RecordsQueryError",
    "check_filter_size",
    "get_record",
    "query_records",
    "record_columns",
    "records_state",
]
