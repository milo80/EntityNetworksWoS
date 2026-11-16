from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth.password_reset import consume_reset_token, send_reset_link, set_password
from ..auth.passwords import hash_password, needs_rehash, verify_password
from ..auth.ratelimit import rate_limit
from ..auth.sessions import CurrentSession, CurrentUser, clear_session_cookies, create_session
from ..config import Settings, get_settings
from ..db import get_db
from ..models import User, UserSession
from ..schemas.api import (
    Credentials,
    MessageOut,
    PasswordResetConfirm,
    PasswordResetRequest,
    Registration,
    SessionOut,
    UserOut,
)

router = APIRouter(prefix="/auth", tags=["auth"])

Db = Annotated[Session, Depends(get_db)]
Config = Annotated[Settings, Depends(get_settings)]


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    response_model=SessionOut,
    dependencies=[Depends(rate_limit("register", lambda: get_settings().register_rate_per_minute))],
)
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


@router.post(
    "/login",
    response_model=SessionOut,
    dependencies=[Depends(rate_limit("login", lambda: get_settings().login_rate_per_minute))],
)
def login(body: Credentials, response: Response, db: Db, settings: Config) -> SessionOut:
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    # verify_password runs even for unknown emails (constant-ish time).
    if (
        not verify_password(user.password_hash if user else None, body.password)
        or user is None
        or not user.is_active
    ):
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


RESET_REQUESTED = (
    "If an account exists for that address, we've sent it a link to reset the password."
)


@router.post(
    "/password-reset/request",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=MessageOut,
    dependencies=[
        Depends(rate_limit("password-reset", lambda: get_settings().password_reset_rate_per_minute))
    ],
)
def request_password_reset(
    body: PasswordResetRequest, background: BackgroundTasks, settings: Config
) -> MessageOut:
    # Same answer whether or not the account exists; the lookup and the email
    # happen after the response is sent.
    background.add_task(send_reset_link, body.email, settings)
    return MessageOut(detail=RESET_REQUESTED)


@router.post(
    "/password-reset/confirm",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[
        Depends(rate_limit("password-reset", lambda: get_settings().password_reset_rate_per_minute))
    ],
)
def confirm_password_reset(body: PasswordResetConfirm, db: Db) -> Response:
    user = consume_reset_token(db, body.token)
    if user is None:
        db.rollback()
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This reset link is invalid or has expired. Ask for a new one.",
        )
    set_password(db, user, body.password)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
