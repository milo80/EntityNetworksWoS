from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from pipeline import custom

from ..auth.ratelimit import rate_limit
from ..auth.sessions import CurrentUser
from ..config import Settings, get_settings
from ..db import get_db
from ..models import Dataset, DatasetFile
from ..schemas.api import (
    AttributeOption,
    CustomParams,
    DatasetOut,
    DatasetProfileOut,
    EntityOption,
    LinkOption,
    ModelOption,
    NetworkOptionsOut,
    RecordFilter,
    RecordOut,
    RecordsPageOut,
)
from ..services.records import RecordsQueryError, check_filter_size, get_record, query_records
from ..services.storage import UploadRejected, dataset_dir, remove_dataset_dir, save_upload

router = APIRouter(prefix="/datasets", tags=["datasets"])

Db = Annotated[Session, Depends(get_db)]
Config = Annotated[Settings, Depends(get_settings)]


def get_owned_dataset(db: Session, user_id: int, dataset_id: int) -> Dataset:
    """The dataset if it belongs to this user; 404 otherwise (don't reveal it exists)."""
    dataset = db.scalar(
        select(Dataset).where(Dataset.id == dataset_id, Dataset.owner_id == user_id)
    )
    if dataset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    return dataset


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=DatasetOut,
    dependencies=[Depends(rate_limit("upload", lambda: get_settings().upload_rate_per_minute))],
)
def create_dataset(
    user: CurrentUser,
    db: Db,
    settings: Config,
    name: Annotated[str, Form(min_length=1, max_length=200)],
    files: Annotated[list[UploadFile], File(description="WoS .xls exports")],
) -> Dataset:
    if not files:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Upload at least one file")
    if len(files) > settings.max_files_per_dataset:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"At most {settings.max_files_per_dataset} files per dataset",
        )

    dataset = Dataset(owner_id=user.id, name=name.strip())
    db.add(dataset)
    db.flush()  # assigns dataset.id for the storage directory
    target = dataset_dir(settings.upload_dir, dataset.id)
    try:
        for upload in files:
            stored = save_upload(upload, target, settings.max_upload_bytes)
            dataset.files.append(
                DatasetFile(
                    original_name=stored.original_name,
                    stored_name=stored.stored_name,
                    size_bytes=stored.size_bytes,
                    sha256=stored.sha256,
                )
            )
        db.commit()
    except UploadRejected as exc:
        db.rollback()
        remove_dataset_dir(settings.upload_dir, dataset.id)
        raise HTTPException(exc.status_code, str(exc))
    except BaseException:
        db.rollback()
        remove_dataset_dir(settings.upload_dir, dataset.id)
        raise
    return dataset


@router.get("", response_model=list[DatasetOut])
def list_datasets(user: CurrentUser, db: Db) -> list[Dataset]:
    return list(
        db.scalars(select(Dataset).where(Dataset.owner_id == user.id).order_by(Dataset.id.desc()))
    )


@router.get("/{dataset_id}", response_model=DatasetOut)
def get_dataset(dataset_id: int, user: CurrentUser, db: Db) -> Dataset:
    return get_owned_dataset(db, user.id, dataset_id)


@router.get("/{dataset_id}/profile", response_model=DatasetProfileOut)
def get_dataset_profile(dataset_id: int, user: CurrentUser, db: Db) -> DatasetProfileOut:
    """Schema, sample and statistics of the uploaded data. Poll while status is 'pending'."""
    dataset = get_owned_dataset(db, user.id, dataset_id)
    return DatasetProfileOut(
        status=dataset.profile_status,
        error=dataset.profile_error,
        profile=dataset.profile if dataset.profile_status == "ready" else None,
    )


@router.get("/{dataset_id}/network-options", response_model=NetworkOptionsOut)
def get_network_options(dataset_id: int, user: CurrentUser, db: Db) -> NetworkOptionsOut:
    """What a custom network can be built from: entities, link fields and models.

    Availability comes from the dataset's profile (column fill). While the
    profile isn't ready, everything is offered.
    """
    return network_options(get_owned_dataset(db, user.id, dataset_id))


def network_options(dataset: Dataset) -> NetworkOptionsOut:
    """The custom-network options of a dataset (see get_network_options)."""
    fill: dict[str, float] | None = None
    if dataset.profile_status == "ready" and dataset.profile:
        fill = {c["name"]: c["non_empty_pct"] for c in dataset.profile.get("schema", [])}
    problems = custom.availability(fill) if fill is not None else None

    def reason(group: str, key: str) -> str | None:
        return problems[group][key] if problems else None

    entities = [
        EntityOption(
            key=key,
            label=spec.label,
            many_per_article=spec.many_per_article,
            available=reason("entities", key) is None,
            reason=reason("entities", key),
            links=[
                link
                for link, lspec in custom.LINKS.items()
                if custom.combination_problem(key, link, lspec.models[0]) is None
            ],
        )
        for key, spec in custom.ENTITIES.items()
    ]
    links = [
        LinkOption(
            key=key,
            label=spec.label,
            kind=spec.kind,
            models=list(spec.models),
            available=reason("links", key) is None,
            reason=reason("links", key),
        )
        for key, spec in custom.LINKS.items()
    ]
    models = [
        ModelOption(
            key=key,
            label=label,
            description=custom.MODEL_DESCRIPTIONS[key],
            threshold_default=custom.THRESHOLD_DEFAULTS.get(key),
        )
        for key, label in custom.MODELS.items()
    ]
    columns = list(fill) if fill is not None else list(custom.DEFAULT_NODE_ATTRIBUTES)
    fields = list(dict.fromkeys([*custom.DERIVED_ATTRIBUTES, *columns]))
    attributes = [
        AttributeOption(
            key=name,
            label=custom.attribute_label(name),
            attr_key=custom.attribute_key(name),
            fill_pct=None if fill is None or name not in fill else fill[name],
            not_for=[e for e in custom.ENTITIES if custom.node_attribute_problem(e, name)],
        )
        for name in fields
    ]
    return NetworkOptionsOut(
        entities=entities,
        links=links,
        models=models,
        attributes=attributes,
        defaults=CustomParams(),
    )


MAX_RECORD_FILTERS = 20
MAX_RECORD_COLUMNS = 300
_FILTERS = TypeAdapter(list[RecordFilter])


def _parse_filters(raw: str | None) -> list[RecordFilter]:
    if not raw:
        return []
    try:
        filters = _FILTERS.validate_json(raw)
    except ValidationError as exc:
        msg = exc.errors()[0]["msg"] if exc.errors() else "invalid"
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"filters: {msg}") from exc
    if len(filters) > MAX_RECORD_FILTERS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"At most {MAX_RECORD_FILTERS} filters"
        )
    try:
        check_filter_size(filters)
    except RecordsQueryError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    return filters


@router.get("/{dataset_id}/records", response_model=RecordsPageOut)
def list_records(
    dataset_id: int,
    user: CurrentUser,
    db: Db,
    page: Annotated[int, Query(ge=1, le=1_000_000)] = 1,
    filters: Annotated[
        str | None,
        Query(
            max_length=20_000,
            description='JSON list of {"column", "op", "value"} (RecordFilter); rows are ANDed',
        ),
    ] = None,
    sort: Annotated[str | None, Query(max_length=300, description="Column to sort by")] = None,
    order: Annotated[Literal["asc", "desc"], Query()] = "asc",
    columns: Annotated[
        list[str] | None,
        Query(
            max_length=MAX_RECORD_COLUMNS,
            description=f"Columns to return (default: all; at most {MAX_RECORD_COLUMNS})",
        ),
    ] = None,
) -> RecordsPageOut:
    """One page (50) of the dataset's article rows, filtered and sorted on the server.

    Without a sort, records come in upload order; empty values sort last both ways.
    Poll while status is 'pending'.
    """
    dataset = get_owned_dataset(db, user.id, dataset_id)
    try:
        return query_records(
            db,
            dataset,
            page=page,
            filters=_parse_filters(filters),
            sort=sort,
            descending=order == "desc",
            columns=columns or [],
        )
    except RecordsQueryError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


@router.get("/{dataset_id}/records/{index}", response_model=RecordOut)
def get_dataset_record(dataset_id: int, index: int, user: CurrentUser, db: Db) -> RecordOut:
    """One record with every column, including the derived ones."""
    dataset = get_owned_dataset(db, user.id, dataset_id)
    record = get_record(db, dataset, index)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Record not found")
    return record


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(dataset_id: int, user: CurrentUser, db: Db, settings: Config) -> None:
    """Deletes the dataset, its files and all of its runs."""
    dataset = get_owned_dataset(db, user.id, dataset_id)
    db.delete(dataset)
    db.commit()
    remove_dataset_dir(settings.upload_dir, dataset_id)
