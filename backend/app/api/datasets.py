from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth.ratelimit import rate_limit
from ..auth.sessions import CurrentUser
from ..config import Settings, get_settings
from ..db import get_db
from ..models import Dataset, DatasetFile
from ..schemas.api import DatasetOut, DatasetProfileOut
from ..services.storage import UploadRejected, dataset_dir, remove_dataset_dir, save_upload

router = APIRouter(prefix="/datasets", tags=["datasets"])

Db = Annotated[Session, Depends(get_db)]
Config = Annotated[Settings, Depends(get_settings)]


def get_owned_dataset(db: Session, user_id: int, dataset_id: int) -> Dataset:
    """The dataset if it belongs to this user; 404 otherwise (don't reveal it exists)."""
    dataset = db.scalar(select(Dataset).where(Dataset.id == dataset_id,
                                              Dataset.owner_id == user_id))
    if dataset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    return dataset


@router.post("", status_code=status.HTTP_201_CREATED, response_model=DatasetOut,
             dependencies=[Depends(rate_limit("upload",
                                              lambda: get_settings().upload_rate_per_minute))])
def create_dataset(user: CurrentUser, db: Db, settings: Config,
                   name: Annotated[str, Form(min_length=1, max_length=200)],
                   files: Annotated[list[UploadFile], File(description="WoS .xls exports")],
                   ) -> Dataset:
    if not files:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Upload at least one file")
    if len(files) > settings.max_files_per_dataset:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"At most {settings.max_files_per_dataset} files per dataset")

    dataset = Dataset(owner_id=user.id, name=name.strip())
    db.add(dataset)
    db.flush()  # assigns dataset.id for the storage directory
    target = dataset_dir(settings.upload_dir, dataset.id)
    try:
        for upload in files:
            stored = save_upload(upload, target, settings.max_upload_bytes)
            dataset.files.append(DatasetFile(original_name=stored.original_name,
                                             stored_name=stored.stored_name,
                                             size_bytes=stored.size_bytes, sha256=stored.sha256))
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
    return list(db.scalars(select(Dataset).where(Dataset.owner_id == user.id)
                           .order_by(Dataset.id.desc())))


@router.get("/{dataset_id}", response_model=DatasetOut)
def get_dataset(dataset_id: int, user: CurrentUser, db: Db) -> Dataset:
    return get_owned_dataset(db, user.id, dataset_id)


@router.get("/{dataset_id}/profile", response_model=DatasetProfileOut)
def get_dataset_profile(dataset_id: int, user: CurrentUser, db: Db) -> DatasetProfileOut:
    """Schema, sample and statistics of the uploaded data. Poll while status is 'pending'."""
    dataset = get_owned_dataset(db, user.id, dataset_id)
    return DatasetProfileOut(status=dataset.profile_status, error=dataset.profile_error,
                             profile=dataset.profile if dataset.profile_status == "ready" else None)


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(dataset_id: int, user: CurrentUser, db: Db, settings: Config) -> None:
    """Deletes the dataset, its files and all of its runs."""
    dataset = get_owned_dataset(db, user.id, dataset_id)
    db.delete(dataset)
    db.commit()
    remove_dataset_dir(settings.upload_dir, dataset_id)
