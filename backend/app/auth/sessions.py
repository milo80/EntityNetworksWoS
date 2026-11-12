"""Cookie sessions, the current-user dependency and CSRF protection.

- Session cookie: random 256-bit token, httpOnly, SameSite=Lax, Secure (prod).
  The database stores only its SHA-256, so a DB leak doesn't leak live sessions.
- CSRF: synchronizer token bound to the session. It is sent to the browser in a
  readable (non-httpOnly) cookie; state-changing requests must echo it in the
  X-CSRF-Token header. A cross-site page can't read the cookie, so it can't
  forge the header.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db, utcnow
from ..models import User, UserSession

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: Session, user: User, response: Response, settings: Settings) -> UserSession:
    token = secrets.token_urlsafe(32)
    session = UserSession(token_hash=_hash_token(token), csrf_token=secrets.token_urlsafe(32),
                          user_id=user.id,
                          expires_at=utcnow() + timedelta(hours=settings.session_ttl_hours))
    db.add(session)
    # Opportunistic cleanup of this user's expired sessions.
    db.execute(delete(UserSession).where(UserSession.user_id == user.id,
                                         UserSession.expires_at < utcnow()))
    db.commit()
    max_age = settings.session_ttl_hours * 3600
    response.set_cookie(settings.session_cookie, token, max_age=max_age, httponly=True,
                        secure=settings.cookie_secure, samesite="lax", path="/")
    response.set_cookie(settings.csrf_cookie, session.csrf_token, max_age=max_age, httponly=False,
                        secure=settings.cookie_secure, samesite="lax", path="/")
    return session


def clear_session_cookies(response: Response, settings: Settings) -> None:
    for name in (settings.session_cookie, settings.csrf_cookie):
        response.delete_cookie(name, path="/", secure=settings.cookie_secure, samesite="lax")


def get_current_session(request: Request, db: Annotated[Session, Depends(get_db)],
                        settings: Annotated[Settings, Depends(get_settings)]) -> UserSession:
    token = request.cookies.get(settings.session_cookie)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    session = db.scalar(select(UserSession).where(UserSession.token_hash == _hash_token(token)))
    if session is None or session.expires_at <= utcnow() or not session.user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired or invalid")

    if request.method not in SAFE_METHODS:
        sent = request.headers.get(settings.csrf_header, "")
        if not hmac.compare_digest(sent, session.csrf_token):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing or invalid CSRF token")
    return session


def get_current_user(session: Annotated[UserSession, Depends(get_current_session)]) -> User:
    return session.user


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin only")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
CurrentSession = Annotated[UserSession, Depends(get_current_session)]
