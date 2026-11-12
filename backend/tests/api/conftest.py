"""API test fixtures. Need a PostgreSQL server; skipped if none is reachable.

TEST_DATABASE_URL (default below) names a throwaway database: it is created if
missing and its schema is dropped and rebuilt with the Alembic migrations at
the start of every test session.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2]
TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://entitynet:entitynet@localhost:5432/entitynet_test")

# Must be set before app settings are first read.
os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ["APP_ENV"] = "test"
os.environ["COOKIE_SECURE"] = "false"
os.environ["LOG_LEVEL"] = "WARNING"

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError

PASSWORD = "correct horse battery"


def _ensure_database(url: str) -> None:
    target = make_url(url)
    admin = create_engine(target.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            exists = conn.scalar(text("SELECT 1 FROM pg_database WHERE datname = :n"),
                                 {"n": target.database})
            if not exists:
                conn.execute(text(f'CREATE DATABASE "{target.database}"'))
    finally:
        admin.dispose()


@pytest.fixture(scope="session")
def database(tmp_path_factory) -> Iterator[str]:
    try:
        _ensure_database(TEST_DATABASE_URL)
    except OperationalError as exc:
        pytest.skip(f"PostgreSQL not reachable at {make_url(TEST_DATABASE_URL)!r}: "
                    f"{exc.orig.__class__.__name__}")

    from alembic.config import Config

    from alembic import command

    engine = create_engine(TEST_DATABASE_URL)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public"))
    engine.dispose()

    cfg = Config(str(BACKEND_DIR / "alembic.ini"), attributes={"configure_logger": False})
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", TEST_DATABASE_URL)
    command.upgrade(cfg, "head")
    yield TEST_DATABASE_URL


@pytest.fixture
def settings(database, tmp_path, monkeypatch):
    from app.config import get_settings
    get_settings.cache_clear()
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    s = get_settings()
    yield s
    get_settings.cache_clear()


@pytest.fixture
def db(settings):
    from app.db import get_engine, get_sessionmaker
    engine = get_engine()
    with engine.begin() as conn:
        tables = conn.scalars(text(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' "
            "AND tablename <> 'alembic_version'")).all()
        conn.execute(text(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE"))
    with get_sessionmaker()() as session:
        yield session


@pytest.fixture
def app(db, settings):
    from app.auth.ratelimit import limiter
    from app.main import create_app
    limiter.reset()
    return create_app()


@pytest.fixture
def make_client(app):
    from fastapi.testclient import TestClient
    clients = []

    def factory() -> TestClient:
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


def register(client, email: str = "ann@example.org", password: str = PASSWORD):
    """Register + log in; sets the CSRF header on the client for later requests."""
    r = client.post("/api/auth/register", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    client.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return r


@pytest.fixture
def client(make_client):
    """A logged-in client."""
    c = make_client()
    register(c)
    return c


OLE2 = bytes.fromhex("D0CF11E0A1B11AE1")


def fake_xls(size: int = 4096) -> bytes:
    """Passes the upload signature check; not a readable workbook."""
    return OLE2 + b"\0" * (size - len(OLE2))


def upload(client, name="My dataset", files=None):
    files = files or [("files", ("WoS_1.xls", fake_xls(), "application/vnd.ms-excel"))]
    return client.post("/api/datasets", data={"name": name}, files=files)
