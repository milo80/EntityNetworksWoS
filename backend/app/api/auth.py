from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth.passwords import hash_password, needs_rehash, verify_password
from ..auth.ratelimit import rate_limit
from ..auth.sessions import CurrentSession, CurrentUser, clear_session_cookies, create_session
from ..config import Settings, get_settings
from ..db import get_db
from ..models import User, UserSession
from ..schemas.api import Credentials, Registration, SessionOut, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])

Db = Annotated[Session, Depends(get_db)]
Config = Annotated[Settings, Depends(get_settings)]


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=SessionOut,
             dependencies=[Depends(rate_limit("register",
                                              lambda: get_settings().register_rate_per_minute))])
def register(body: Registration, response: Response, db: Db, settings: Config) -> SessionOut:
    if not settings.allow_registration:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Registration is disabled")
    user = User(email=body.email.lower(), password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists")
    session = create_session(db, user, response, settings)
    return SessionOut(user=UserOut.model_validate(user), csrf_token=session.csrf_token)


@router.post("/login", response_model=SessionOut,
             dependencies=[Depends(rate_limit("login",
                                              lambda: get_settings().login_rate_per_minute))])
def login(body: Credentials, response: Response, db: Db, settings: Config) -> SessionOut:
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    # verify_password runs even for unknown emails (constant-ish time).
    if not verify_password(user.password_hash if user else None, body.password) \
            or user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    session = create_session(db, user, response, settings)
    return SessionOut(user=UserOut.model_validate(user), csrf_token=session.csrf_token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(session: CurrentSession, db: Db, settings: Config) -> Response:
    db.execute(delete(UserSession).where(UserSession.id == session.id))
    db.commit()
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session_cookies(response, settings)
    return response


@router.get("/me", response_model=SessionOut)
def me(session: CurrentSession, user: CurrentUser) -> SessionOut:
    return SessionOut(user=UserOut.model_validate(user), csrf_token=session.csrf_token)
