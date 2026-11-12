from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..db import get_db

router = APIRouter(tags=["health"])


@router.get("/health")
def health(response: Response, db: Annotated[Session, Depends(get_db)]) -> dict:
    """Liveness + database check, for the uptime monitor."""
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "error", "database": "unreachable"}
    return {"status": "ok", "database": "ok"}
