from datetime import timedelta

from sqlalchemy import update

from app.db import utcnow
from app.models import UserSession

from .conftest import PASSWORD, register


def test_health(make_client):
    r = make_client().get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "database": "ok"}


def test_register_sets_secure_session_cookies(make_client):
    c = make_client()
    r = register(c, email="Ann@Example.org")
    assert r.json()["user"]["email"] == "ann@example.org"  # stored lowercased
    cookies = r.headers.get_list("set-cookie")
    session_cookie = next(h for h in cookies if h.startswith("entitynet_session="))
    csrf_cookie = next(h for h in cookies if h.startswith("entitynet_csrf="))
    assert "HttpOnly" in session_cookie and "SameSite=lax" in session_cookie
    assert "HttpOnly" not in csrf_cookie  # the UI must be able to read it
    assert c.get("/api/auth/me").json()["user"]["email"] == "ann@example.org"


def test_register_rejects_duplicate_and_weak(make_client):
    c = make_client()
    register(c)
    r = make_client().post("/api/auth/register",
                           json={"email": "ANN@example.org", "password": PASSWORD})
    assert r.status_code == 409
    r = make_client().post("/api/auth/register", json={"email": "b@example.org", "password": "short"})
    assert r.status_code == 422
    r = make_client().post("/api/auth/register", json={"email": "nope", "password": PASSWORD})
    assert r.status_code == 422


def test_registration_can_be_disabled(make_client, settings, monkeypatch):
    monkeypatch.setattr(settings, "allow_registration", False)
    r = make_client().post("/api/auth/register", json={"email": "a@example.org", "password": PASSWORD})
    assert r.status_code == 403


def test_login_and_failures_look_the_same(make_client):
    register(make_client())
    c = make_client()
    wrong = c.post("/api/auth/login", json={"email": "ann@example.org", "password": "wrong-pass"})
    unknown = c.post("/api/auth/login", json={"email": "who@example.org", "password": "wrong-pass"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()
    ok = c.post("/api/auth/login", json={"email": "ann@example.org", "password": PASSWORD})
    assert ok.status_code == 200 and ok.json()["csrf_token"]


def test_protected_endpoints_need_login(make_client):
    c = make_client()
    for path in ("/api/auth/me", "/api/datasets", "/api/runs"):
        assert c.get(path).status_code == 401


def test_logout_needs_csrf_and_invalidates_session(client):
    token = client.headers.pop("X-CSRF-Token")
    assert client.post("/api/auth/logout").status_code == 403
    assert client.post("/api/auth/logout", headers={"X-CSRF-Token": "forged"}).status_code == 403
    assert client.post("/api/auth/logout", headers={"X-CSRF-Token": token}).status_code == 204
    assert client.get("/api/auth/me").status_code == 401


def test_stolen_cookie_unusable_after_logout(make_client):
    c = make_client()
    register(c)
    stolen = c.cookies.get("entitynet_session")
    c.post("/api/auth/logout")
    attacker = make_client()
    attacker.cookies.set("entitynet_session", stolen)
    assert attacker.get("/api/auth/me").status_code == 401


def test_expired_session_rejected(client, db):
    db.execute(update(UserSession).values(expires_at=utcnow() - timedelta(seconds=1)))
    db.commit()
    assert client.get("/api/auth/me").status_code == 401


def test_login_rate_limited(make_client, settings, monkeypatch):
    monkeypatch.setattr(settings, "login_rate_per_minute", 3)
    c = make_client()
    codes = [c.post("/api/auth/login", json={"email": "x@example.org", "password": "whatever1"}
                    ).status_code for _ in range(5)]
    assert codes == [401, 401, 401, 429, 429]
