import pytest

from app.worker import profile_next_dataset, run_once

from ..fixtures.synthetic_wos import synthetic_wos_df
from .conftest import register, upload


@pytest.fixture
def synthetic_reader(monkeypatch):
    monkeypatch.setattr("app.worker.read_wos_files", lambda files: synthetic_wos_df())


def test_profile_lifecycle(client, db, settings, synthetic_reader):
    ds = upload(client).json()
    assert ds["profile_status"] == "pending"
    pending = client.get(f"/api/datasets/{ds['id']}/profile").json()
    assert pending == {"status": "pending", "error": None, "profile": None}

    assert profile_next_dataset(db, settings) is True
    assert profile_next_dataset(db, settings) is False  # nothing pending any more

    r = client.get(f"/api/datasets/{ds['id']}/profile").json()
    assert r["status"] == "ready" and r["error"] is None
    assert r["profile"]["stats"]["articles"] == 6
    assert {c["name"] for c in r["profile"]["schema"]} >= {"Author Full Names", "ORCIDs"}
    assert client.get(f"/api/datasets/{ds['id']}").json()["profile_status"] == "ready"


def test_unreadable_files_mark_profile_failed(client, db, settings):
    ds = upload(client).json()  # fake .xls bytes, real reader
    run_once(db, settings)
    r = client.get(f"/api/datasets/{ds['id']}/profile").json()
    assert r["status"] == "failed" and r["profile"] is None
    assert "Could not read" in r["error"] and "/" not in r["error"]


def test_profile_is_private(make_client, client, db, settings, synthetic_reader):
    ds = upload(client).json()
    profile_next_dataset(db, settings)
    bob = make_client()
    register(bob, "bob@example.org")
    assert bob.get(f"/api/datasets/{ds['id']}/profile").status_code == 404


def test_listing_datasets_does_not_load_profiles(client, db, settings, synthetic_reader):
    upload(client)
    profile_next_dataset(db, settings)
    listed = client.get("/api/datasets").json()[0]
    assert listed["profile_status"] == "ready"
    assert "profile" not in listed  # only via /profile
