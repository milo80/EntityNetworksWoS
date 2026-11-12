import pytest
from sqlalchemy import select

from app.db import get_sessionmaker
from app.models import NetworkRun
from app.worker import claim_next_run, recover_orphaned_runs, run_once
from pipeline.schema import validate_network

from ..fixtures.synthetic_wos import synthetic_wos_df
from .conftest import upload


@pytest.fixture
def dataset(client):
    return upload(client).json()


@pytest.fixture
def synthetic_pipeline(monkeypatch):
    """Make the worker read the synthetic WoS table instead of the uploaded bytes."""
    monkeypatch.setattr("app.services.runs.read_wos_files", lambda files: synthetic_wos_df())


def _create_run(client, dataset_id, relation="author", params=None):
    body = {"dataset_id": dataset_id, "relation": relation}
    if params is not None:
        body["params"] = params
    return client.post("/api/runs", json=body)


@pytest.mark.parametrize("body", [
    {"relation": "author", "params": {"top_n": 5}},
    {"relation": "author", "params": {"colour": "red"}},
    {"relation": "author", "params": {"team_attribute": "planet"}},
    {"relation": "institution_keywords", "params": {"max_keyword_df": 0}},
    {"relation": "author", "params": {"max_keyword_df": 0.5}},  # wrong relation's param
    {"relation": "coauthor_magic"},
])
def test_invalid_run_requests(client, dataset, body):
    assert client.post("/api/runs", json={"dataset_id": dataset["id"], **body}).status_code == 422


def test_run_is_queued_with_full_default_params(client, dataset):
    r = _create_run(client, dataset["id"], params={"top_n": 50})
    assert r.status_code == 202
    run = r.json()
    assert run["status"] == "queued"
    assert run["params"]["top_n"] == 50 and run["params"]["max_authors"] == 15
    assert client.get(f"/api/runs/{run['id']}/network").status_code == 409


def test_worker_builds_network(client, dataset, settings, db, synthetic_pipeline):
    run = _create_run(client, dataset["id"]).json()
    assert run_once(db, settings) is True
    assert run_once(db, settings) is False  # queue empty

    status = client.get(f"/api/runs/{run['id']}").json()
    assert status["status"] == "succeeded", status
    assert status["started_at"] and status["finished_at"]

    r = client.get(f"/api/runs/{run['id']}/network")
    assert r.status_code == 200 and r.headers["content-type"] == "application/json"
    network = validate_network(r.content)
    assert len(network.nodes) == status["node_count"] > 0
    assert len(network.edges) == status["edge_count"] > 0

    etag = r.headers["etag"]
    assert client.get(f"/api/runs/{run['id']}/network",
                      headers={"If-None-Match": etag}).status_code == 304

    export = client.get(f"/api/runs/{run['id']}/export")
    assert export.headers["content-disposition"] == \
        f'attachment; filename="network_author_{run["id"]}.json"'
    assert export.json() == r.json()


def test_worker_institution_network_with_params(client, dataset, settings, db,
                                                synthetic_pipeline):
    run = _create_run(client, dataset["id"], "institution_keywords",
                      {"max_keyword_df": 0.5, "min_shared_keywords": 2}).json()
    run_once(db, settings)
    assert client.get(f"/api/runs/{run['id']}").json()["edge_count"] > 0


def test_unreadable_upload_fails_with_message(client, dataset, settings, db):
    run = _create_run(client, dataset["id"]).json()
    run_once(db, settings)  # real reader on fake .xls bytes
    status = client.get(f"/api/runs/{run['id']}").json()
    assert status["status"] == "failed"
    assert "Could not read" in status["error"]
    assert "/" not in status["error"]  # no server paths leaked


def test_runs_are_private(make_client, client, dataset):
    from .conftest import register
    run = _create_run(client, dataset["id"]).json()
    bob = make_client()
    register(bob, "bob@example.org")
    assert bob.get("/api/runs").json() == []
    for path in (f"/api/runs/{run['id']}", f"/api/runs/{run['id']}/network",
                 f"/api/runs/{run['id']}/export"):
        assert bob.get(path).status_code == 404
    assert bob.delete(f"/api/runs/{run['id']}").status_code == 404


def test_claim_skips_runs_locked_by_another_worker(client, dataset, db):
    first = _create_run(client, dataset["id"]).json()
    second = _create_run(client, dataset["id"]).json()
    other = get_sessionmaker()()
    try:
        # Another transaction holds the oldest queued row...
        other.scalars(select(NetworkRun).where(NetworkRun.id == first["id"])
                      .with_for_update()).one()
        # ...so this worker skips it instead of blocking.
        claimed = claim_next_run(db)
        assert claimed.id == second["id"]
    finally:
        other.rollback()
        other.close()


def test_orphaned_runs_requeued_then_failed(client, dataset, db, settings):
    run_id = _create_run(client, dataset["id"]).json()["id"]
    for attempt in range(1, settings.worker_max_attempts + 1):
        assert claim_next_run(db).id == run_id  # worker "crashes" while running
        recover_orphaned_runs(db, settings.worker_max_attempts)
        expected = "queued" if attempt < settings.worker_max_attempts else "failed"
        assert client.get(f"/api/runs/{run_id}").json()["status"] == expected
    assert "attempts exhausted" in client.get(f"/api/runs/{run_id}").json()["error"]


def test_delete_run(client, dataset):
    run = _create_run(client, dataset["id"]).json()
    assert client.delete(f"/api/runs/{run['id']}").status_code == 204
    assert client.get("/api/runs").json() == []
