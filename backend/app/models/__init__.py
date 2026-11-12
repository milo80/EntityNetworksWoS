"""ORM models. Every user-owned row carries owner_id; queries must always filter on it."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, deferred, mapped_column, relationship

from ..db import Base, utcnow

RUN_STATUSES = ("queued", "running", "succeeded", "failed")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)  # stored lowercased
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="user")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (CheckConstraint("role IN ('user', 'admin')", name="role"),)


class UserSession(Base):
    """Server-side login session. Only a SHA-256 of the cookie token is stored."""

    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    user: Mapped[User] = relationship(lazy="joined")


class Dataset(Base):
    """A set of uploaded WoS export files."""

    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    files: Mapped[list[DatasetFile]] = relationship(
        back_populates="dataset", cascade="all, delete-orphan", passive_deletes=True,
        order_by="DatasetFile.id", lazy="selectin")


class DatasetFile(Base):
    __tablename__ = "dataset_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id", ondelete="CASCADE"),
                                            index=True)
    original_name: Mapped[str] = mapped_column(String(255))
    stored_name: Mapped[str] = mapped_column(String(64))  # random name on disk, never user input
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))

    dataset: Mapped[Dataset] = relationship(back_populates="files")


class NetworkRun(Base):
    """One pipeline execution: dataset + relation + parameters -> network JSON.

    Doubles as the job queue: the worker claims 'queued' rows with
    SELECT ... FOR UPDATE SKIP LOCKED.
    """

    __tablename__ = "network_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id", ondelete="CASCADE"),
                                            index=True)
    relation: Mapped[str] = mapped_column(String(50))
    params: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    node_count: Mapped[int | None] = mapped_column(Integer)
    edge_count: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The network JSON (up to a few MB) - deferred so listing runs never loads it.
    result: Mapped[dict[str, Any] | None] = deferred(mapped_column(JSONB))

    __table_args__ = (
        CheckConstraint("status IN ('queued', 'running', 'succeeded', 'failed')", name="status"),
    )


__all__ = ["RUN_STATUSES", "Dataset", "DatasetFile", "NetworkRun", "User", "UserSession"]
