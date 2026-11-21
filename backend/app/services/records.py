"""Filtering, sorting and paging a dataset's records (pipeline.records) in SQL.

The rows are JSONB objects (column -> value, empty ones left out), so every
filter reads ``data ->> column``. The rules match the explorer's attribute
search: ";" separates alternatives in a filter (OR), filters combine with AND,
terms are trimmed and compared case-insensitively, and empty terms are dropped.
"""

from __future__ import annotations

from typing import Any, cast

from psycopg.errors import QueryCanceled
from sqlalchemy import ColumnElement, Select, case, func, literal, not_, or_, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from pipeline.keywords import normalize_keyword
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
    """'a; B ;; a' -> ['a', 'b'] (as visibility.parseAttrRows in the UI, deduplicated)."""
    return list(dict.fromkeys(t for part in value.split(";") if (t := part.strip().lower())))


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


def _contains(column: str, values: list[str]) -> ColumnElement[bool]:
    """Case-insensitive substring; keyword columns also treat hyphens as spaces, as the
    keyword networks do (also used, negated, by "does not contain")."""
    cell = func.lower(func.coalesce(_text(column), ""))
    if column in KEYWORD_COLUMNS:
        cell = func.replace(cell, "-", " ")
        values = list(dict.fromkeys(normalize_keyword(t) for t in values))
    return or_(*(func.strpos(cell, t) > 0 for t in values))


def _has_item(column: str, values: list[str]) -> ColumnElement[bool]:
    """A ";"-separated item equals a term (keyword columns normalized as networks do)."""
    items = func.unnest(func.string_to_array(_text(column), ";")).column_valued("item")
    item = func.lower(func.btrim(items, SPACES))
    wanted = values
    if column in KEYWORD_COLUMNS:
        item = func.replace(item, "-", " ")
        wanted = list(dict.fromkeys(normalize_keyword(t) for t in values))
    return select(literal(1)).where(item.in_(wanted)).exists()


def _condition(f: RecordFilter) -> ColumnElement[bool] | None:
    if f.op == "is_empty":
        return _text(f.column).is_(None)
    if f.op == "not_empty":
        return _text(f.column).is_not(None)
    values = terms(f.value)
    if not values:
        return None  # nothing to match: the row is ignored, as in the explorer
    if f.op == "contains":
        return _contains(f.column, values)
    if f.op == "not_contains":
        return not_(_contains(f.column, values))
    return _has_item(f.column, values)


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
    conditions = [c for f in filters if f.column in by_name and (c := _condition(f)) is not None]
    own = DatasetRecord.dataset_id == dataset.id
    # Bounded: this transaction's statements are cancelled after the timeout.
    db.execute(text(f"SET LOCAL statement_timeout = {int(STATEMENT_TIMEOUT_MS)}"))
    try:
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
    matching = db.scalar(select(func.count()).where(own, *conditions)) or 0 if conditions else total

    query: Select = select(DatasetRecord.position, DatasetRecord.data).where(own, *conditions)
    if sort in by_name:
        key = _sort_key(by_name[sort])
        query = query.order_by(key.desc().nulls_last() if descending else key.asc().nulls_last())
    query = query.order_by(DatasetRecord.position)
    query = query.offset((page - 1) * RECORDS_PAGE_SIZE).limit(RECORDS_PAGE_SIZE)

    wanted = [c for c in columns if c in by_name] or list(by_name)
    rows = [
        RecordOut(index=position, values={c: data[c] for c in wanted if c in data})
        for position, data in db.execute(query)
    ]
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
