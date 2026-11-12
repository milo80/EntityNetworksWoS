from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response, status
from sqlalchemy import Text, cast, select
from sqlalchemy.orm import Session

from ..auth.sessions import CurrentUser
from ..db import get_db
from ..models import NetworkRun
from ..schemas.api import RunCreate, RunOut
from ..schemas.network import Network
from .datasets import get_owned_dataset

router = APIRouter(prefix="/runs", tags=["runs"])

Db = Annotated[Session, Depends(get_db)]


def get_owned_run(db: Session, user_id: int, run_id: int) -> NetworkRun:
    run = db.scalar(select(NetworkRun).where(NetworkRun.id == run_id,
                                             NetworkRun.owner_id == user_id))
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Run not found")
    return run


@router.post("", status_code=status.HTTP_202_ACCEPTED, response_model=RunOut)
def create_run(body: Annotated[RunCreate, Body()], user: CurrentUser, db: Db) -> NetworkRun:
    """Queue a network build. Poll GET /runs/{id} until status is succeeded/failed."""
    get_owned_dataset(db, user.id, body.dataset_id)
    run = NetworkRun(owner_id=user.id, dataset_id=body.dataset_id, relation=body.relation,
                     params=body.params.model_dump())
    db.add(run)
    db.commit()
    return run


@router.get("", response_model=list[RunOut])
def list_runs(user: CurrentUser, db: Db, dataset_id: int | None = None) -> list[NetworkRun]:
    query = select(NetworkRun).where(NetworkRun.owner_id == user.id)
    if dataset_id is not None:
        query = query.where(NetworkRun.dataset_id == dataset_id)
    return list(db.scalars(query.order_by(NetworkRun.id.desc())))


@router.get("/{run_id}", response_model=RunOut)
def get_run(run_id: int, user: CurrentUser, db: Db) -> NetworkRun:
    return get_owned_run(db, user.id, run_id)


@router.delete("/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_run(run_id: int, user: CurrentUser, db: Db) -> None:
    db.delete(get_owned_run(db, user.id, run_id))
    db.commit()


def _network_response(run_id: int, request: Request, user_id: int, db: Session,
                      download: bool) -> Response:
    run = get_owned_run(db, user_id, run_id)
    if run.status != "succeeded":
        raise HTTPException(status.HTTP_409_CONFLICT, f"Run is {run.status}, no network yet")

    # A succeeded run's result never changes, so its id is a valid ETag.
    etag = f'"run-{run.id}"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if download:
        headers["Content-Disposition"] = \
            f'attachment; filename="network_{run.relation}_{run.id}.json"'
    elif request.headers.get("if-none-match") == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)

    # Let Postgres serialize the JSONB: no parse/re-serialize of MBs in Python.
    body = db.scalar(select(cast(NetworkRun.result, Text)).where(NetworkRun.id == run.id))
    return Response(content=body, media_type="application/json", headers=headers)


@router.get("/{run_id}/network", responses={200: {
    "model": Network, "description": "Network JSON (see docs/network.schema.json)"}})
def get_network(run_id: int, request: Request, user: CurrentUser, db: Db) -> Response:
    return _network_response(run_id, request, user.id, db, download=False)


@router.get("/{run_id}/export")
def export_network(run_id: int, request: Request, user: CurrentUser, db: Db) -> Response:
    return _network_response(run_id, request, user.id, db, download=True)
