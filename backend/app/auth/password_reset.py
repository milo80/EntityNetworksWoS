"""Password reset by emailed one-time link, and setting a password.

- The link carries a random 256-bit token; the database stores only its
  SHA-256 (like sessions), so a DB leak doesn't leak usable links.
- A token is single-use, expires after PASSWORD_RESET_TTL_MINUTES, and asking
  for a new link invalidates the older ones.
- Setting a password (by link or by the admin CLI) ends all of the user's
  sessions and voids their outstanding reset links.
"""

from __future__ import annotations

import logging
import secrets
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..db import get_sessionmaker, utcnow
from ..models import PasswordResetToken, User, UserSession
from ..services.mailer import send_email
from .passwords import hash_password
from .sessions import hash_token

log = logging.getLogger(__name__)


def create_reset_token(db: Session, user: User, settings: Settings) -> str:
    """Store a new token for ``user`` (voiding older ones) and return it in clear."""
    db.execute(delete(PasswordResetToken).where(PasswordResetToken.user_id == user.id))
    token = secrets.token_urlsafe(32)
    db.add(PasswordResetToken(
        token_hash=hash_token(token), user_id=user.id,
        expires_at=utcnow() + timedelta(minutes=settings.password_reset_ttl_minutes)))
    db.commit()
    return token


def send_reset_link(email: str, settings: Settings) -> None:
    """Background task: email a reset link if ``email`` belongs to an active user.

    Runs after the response is sent, so the response (content and timing) is the
    same whether or not the account exists.
    """
    with get_sessionmaker()() as db:
        user = db.scalar(select(User).where(User.email == email.lower()))
        if user is None or not user.is_active:
            log.info("Password reset requested for an unknown or inactive account")
            return
        token = create_reset_token(db, user, settings)
    link = f"{settings.public_base_url}/reset-password?token={token}"
    send_email(settings, user.email, "Reset your EntityNetworks password",
               "Someone (hopefully you) asked to reset the password for this "
               "EntityNetworks account.\n\n"
               f"Open this link to choose a new password:\n{link}\n\n"
               f"The link works once and expires in {settings.password_reset_ttl_minutes} "
               "minutes. If you didn't ask for this, ignore this email; your password "
               "stays the same.\n")


def consume_reset_token(db: Session, token: str) -> User | None:
    """Return the token's user and mark it used, or None if invalid/expired/used."""
    row = db.scalar(select(PasswordResetToken)
                    .where(PasswordResetToken.token_hash == hash_token(token))
                    .with_for_update(of=PasswordResetToken))
    if row is None or row.used_at is not None or row.expires_at <= utcnow() \
            or not row.user.is_active:
        return None
    row.used_at = utcnow()
    return row.user


def set_password(db: Session, user: User, password: str) -> None:
    """Set a new password, end all of the user's sessions, void their reset links."""
    user.password_hash = hash_password(password)
    db.execute(delete(UserSession).where(UserSession.user_id == user.id))
    db.execute(delete(PasswordResetToken).where(PasswordResetToken.user_id == user.id))
    db.commit()
