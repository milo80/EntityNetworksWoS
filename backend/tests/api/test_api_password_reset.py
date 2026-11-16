import logging
import re
from datetime import timedelta

import pytest
from sqlalchemy import select, update

from app.db import utcnow
from app.models import PasswordResetToken, User

from .conftest import PASSWORD, register

NEW_PASSWORD = "a brand new passphrase"


@pytest.fixture
def outbox(monkeypatch):
    """Captures emails instead of sending them."""
    sent: list[dict] = []
    monkeypatch.setattr(
        "app.auth.password_reset.send_email",
        lambda settings, to, subject, body: sent.append(
            {"to": to, "subject": subject, "body": body}
        ),
    )
    return sent


def request_reset(client, email="ann@example.org"):
    return client.post("/api/auth/password-reset/request", json={"email": email})


def token_from(mail: dict) -> str:
    match = re.search(r"/reset-password\?token=([\w-]+)", mail["body"])
    assert match, mail["body"]
    return match.group(1)


def confirm(client, token, password=NEW_PASSWORD):
    return client.post(
        "/api/auth/password-reset/confirm", json={"token": token, "password": password}
    )


def login(client, password):
    return client.post("/api/auth/login", json={"email": "ann@example.org", "password": password})


def test_unknown_and_known_email_get_the_same_answer(make_client, outbox, settings):
    register(make_client())
    c = make_client()
    unknown = request_reset(c, "who@example.org")
    known = request_reset(c, "ANN@example.org")
    assert unknown.status_code == known.status_code == 202
    assert unknown.json() == known.json()
    assert [m["to"] for m in outbox] == ["ann@example.org"]
    assert f"{settings.public_base_url}/reset-password?token=" in outbox[0]["body"]


def test_reset_sets_password_and_ends_sessions(make_client, outbox, db):
    victim = make_client()
    register(victim)
    c = make_client()
    request_reset(c)
    token = token_from(outbox[0])
    # Only the hash is stored.
    assert db.scalar(select(PasswordResetToken.token_hash)) != token

    assert confirm(c, token).status_code == 204
    assert victim.get("/api/auth/me").status_code == 401  # logged out everywhere
    assert login(c, PASSWORD).status_code == 401
    assert login(c, NEW_PASSWORD).status_code == 200


def test_token_is_single_use(make_client, outbox):
    register(make_client())
    c = make_client()
    request_reset(c)
    token = token_from(outbox[0])
    assert confirm(c, token).status_code == 204
    r = confirm(c, token, "yet another passphrase")
    assert r.status_code == 400 and "invalid or has expired" in r.json()["detail"]


def test_new_request_voids_older_links(make_client, outbox):
    register(make_client())
    c = make_client()
    request_reset(c)
    request_reset(c)
    first, second = token_from(outbox[0]), token_from(outbox[1])
    assert confirm(c, first).status_code == 400
    assert confirm(c, second).status_code == 204


def test_expired_and_bogus_tokens_rejected(make_client, outbox, db):
    register(make_client())
    c = make_client()
    request_reset(c)
    db.execute(update(PasswordResetToken).values(expires_at=utcnow() - timedelta(seconds=1)))
    db.commit()
    assert confirm(c, token_from(outbox[0])).status_code == 400
    assert confirm(c, "not-a-real-token").status_code == 400
    assert login(c, PASSWORD).status_code == 200  # unchanged


def test_weak_password_rejected(make_client, outbox):
    register(make_client())
    c = make_client()
    request_reset(c)
    assert confirm(c, token_from(outbox[0]), "short").status_code == 422


def test_inactive_user_gets_no_link(make_client, outbox, db):
    register(make_client())
    db.execute(update(User).values(is_active=False))
    db.commit()
    assert request_reset(make_client()).status_code == 202
    assert outbox == []


def test_reset_is_rate_limited(make_client, outbox, settings, monkeypatch):
    monkeypatch.setattr(settings, "password_reset_rate_per_minute", 2)
    c = make_client()
    codes = [request_reset(c, "x@example.org").status_code for _ in range(3)]
    assert codes == [202, 202, 429]


def test_without_smtp_the_link_is_logged(make_client, caplog, settings, monkeypatch):
    monkeypatch.setattr(settings, "smtp_host", None)
    register(make_client())
    # The app's logging setup replaces the root handlers, so attach pytest's here.
    mailer_log = logging.getLogger("app.services.mailer")
    mailer_log.addHandler(caplog.handler)
    try:
        request_reset(make_client())
    finally:
        mailer_log.removeHandler(caplog.handler)
    assert "/reset-password?token=" in caplog.text


def test_manage_set_password(make_client, db, monkeypatch, capsys):
    from app import manage

    victim = make_client()
    register(victim)
    monkeypatch.setattr(manage.getpass, "getpass", lambda prompt: NEW_PASSWORD)
    assert manage.main(["set-password", "Ann@example.org"]) == 0
    assert victim.get("/api/auth/me").status_code == 401
    assert login(make_client(), NEW_PASSWORD).status_code == 200
    assert manage.main(["set-password", "nobody@example.org"]) == 1
