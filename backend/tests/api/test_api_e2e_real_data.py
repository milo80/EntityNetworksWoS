"""Full chain on the real WoS sample: upload -> run -> worker -> download.

Must reproduce the golden networks exactly. Skipped when data/wos/ is absent.
"""

import json

import pytest

from app.worker import run_once

from ..conftest import GOLDEN_DIR, WOS_DIR


@pytest.mark.parametrize("relation, golden", [
    ("author", "network_author.json"),
    ("institution_keywords", "network_institution_keywords.json"),
])
def test_real_upload_reproduces_golden(client, db, settings, relation, golden):
    # Upload in reverse name order: the result must not depend on upload order.
    paths = sorted(WOS_DIR.glob("*.xls"), reverse=True)
    if not paths:
        pytest.skip(f"WoS sample not present in {WOS_DIR}")
    files = [("files", (p.name, p.read_bytes(), "application/vnd.ms-excel")) for p in paths]
    ds = client.post("/api/datasets", data={"name": "WoS AI sample"}, files=files)
    assert ds.status_code == 201, ds.text

    run = client.post("/api/runs", json={"dataset_id": ds.json()["id"], "relation": relation})
    run_once(db, settings)
    status = client.get(f"/api/runs/{run.json()['id']}").json()
    assert status["status"] == "succeeded", status

    network = client.get(f"/api/runs/{run.json()['id']}/network").json()
    assert network == json.loads((GOLDEN_DIR / golden).read_text(encoding="utf-8"))
