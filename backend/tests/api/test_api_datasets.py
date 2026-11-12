import hashlib

from .conftest import fake_xls, register, upload


def _files(*specs):
    return [("files", (name, content, "application/vnd.ms-excel")) for name, content in specs]


def test_upload_stores_files_under_random_names(client, settings):
    a, b = fake_xls(5000), fake_xls(7000)
    r = upload(client, files=_files(("WoS_1.xls", a), ("../../etc/WoS_2.XLS", b)))
    assert r.status_code == 201, r.text
    body = r.json()
    assert [f["original_name"] for f in body["files"]] == ["WoS_1.xls", "WoS_2.XLS"]
    assert body["files"][0]["sha256"] == hashlib.sha256(a).hexdigest()
    assert body["files"][1]["size_bytes"] == 7000

    stored = sorted((settings.upload_dir / str(body["id"])).iterdir())
    assert len(stored) == 2
    assert all(p.suffix == ".xls" and len(p.stem) == 32 for p in stored)  # random hex names
    assert sorted(p.stat().st_size for p in stored) == [5000, 7000]


def test_upload_rejections_leave_nothing_behind(client, settings, monkeypatch):
    cases = [
        (_files(("notes.txt", fake_xls())), 415),
        (_files(("WoS.xls", b"PK\x03\x04 this is an xlsx/zip")), 415),
        (_files(("ok.xls", fake_xls()), ("empty.xls", b"")), 400),
    ]
    for files, code in cases:
        assert upload(client, files=files).status_code == code

    monkeypatch.setattr(settings, "max_upload_mb", 1)
    assert upload(client, files=_files(("big.xls", fake_xls(1024 * 1024 + 1)))).status_code == 413

    monkeypatch.setattr(settings, "max_files_per_dataset", 2)
    three = _files(*[(f"f{i}.xls", fake_xls()) for i in range(3)])
    assert upload(client, files=three).status_code == 400

    assert client.get("/api/datasets").json() == []
    assert not settings.upload_dir.exists() or not any(settings.upload_dir.iterdir())


def test_upload_requires_csrf(client):
    del client.headers["X-CSRF-Token"]
    assert upload(client).status_code == 403


def test_datasets_are_private(make_client):
    ann, bob = make_client(), make_client()
    register(ann, "ann@example.org")
    register(bob, "bob@example.org")
    ds = upload(ann).json()

    assert bob.get("/api/datasets").json() == []
    assert bob.get(f"/api/datasets/{ds['id']}").status_code == 404
    assert bob.delete(f"/api/datasets/{ds['id']}").status_code == 404
    assert bob.post("/api/runs", json={"dataset_id": ds["id"], "relation": "author"}
                    ).status_code == 404
    assert ann.get(f"/api/datasets/{ds['id']}").status_code == 200


def test_delete_dataset_removes_files_and_runs(client, settings):
    ds = upload(client).json()
    run = client.post("/api/runs", json={"dataset_id": ds["id"], "relation": "author"}).json()
    assert client.delete(f"/api/datasets/{ds['id']}").status_code == 204
    assert not (settings.upload_dir / str(ds["id"])).exists()
    assert client.get(f"/api/runs/{run['id']}").status_code == 404
