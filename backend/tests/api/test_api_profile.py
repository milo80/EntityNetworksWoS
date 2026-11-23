import ast
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from sqlalchemy import delete, func, select, text

from app.models import Dataset, DatasetRecord
from app.worker import profile_next_dataset, run_once
from pipeline.profile import PROFILE_VERSION, RECORDS_SINCE_VERSION

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


def test_network_options_follow_the_profile(client, db, settings, synthetic_reader):
    ds = upload(client).json()
    pending = client.get(f"/api/datasets/{ds['id']}/network-options").json()
    assert all(e["available"] for e in pending["entities"])  # no profile yet: offer everything

    profile_next_dataset(db, settings)
    options = client.get(f"/api/datasets/{ds['id']}/network-options").json()
    entities = {e["key"]: e for e in options["entities"]}
    links = {lk["key"]: lk for lk in options["links"]}
    assert entities["author"]["available"] and links["keywords"]["available"]
    assert not entities["funder"]["available"]
    assert "Funding Orgs" in entities["funder"]["reason"]
    assert "journal" not in entities["journal"]["links"]  # not by its own field
    assert "same_article" not in entities["journal"]["links"]  # one per article
    assert links["article_title"]["models"] == ["word_overlap", "character_similarity"]
    models = {m["key"]: m for m in options["models"]}
    assert models["character_similarity"]["threshold_default"] == 0.9
    assert options["defaults"]["entity"] == "institution"
    assert options["defaults"]["node_attributes"] == [
        "Research Areas",
        "country",
        "Publication Year",
        "WoS Categories",
        "Document Type",
    ]
    attributes = {a["key"]: a for a in options["attributes"]}
    assert list(attributes)[:2] == ["country", "articles"]  # derived fields first
    assert attributes["Publication Year"]["attr_key"] == "publication_year"
    assert attributes["Publication Year"]["fill_pct"] == 100.0
    assert attributes["Article Title"]["label"] == "Article Title"  # every column is offered
    assert "country" in attributes["country"]["not_for"]  # its own field
    assert attributes["articles"]["not_for"] == []


def test_network_options_are_private(make_client, client):
    ds = upload(client).json()
    other = make_client()
    register(other, "bob@example.org")
    assert other.get(f"/api/datasets/{ds['id']}/network-options").status_code == 404


def test_outdated_profile_is_refreshed_in_place(client, db, settings, synthetic_reader):
    ds = upload(client).json()
    profile_next_dataset(db, settings)
    row = db.get(Dataset, ds["id"])
    row.profile = {"version": PROFILE_VERSION - 1, "stats": {"articles": 6}}
    db.commit()

    # Nothing pending: the worker refreshes the old profile, the dataset stays ready.
    assert profile_next_dataset(db, settings) is True
    r = client.get(f"/api/datasets/{ds['id']}/profile").json()
    assert r["status"] == "ready"
    assert r["profile"]["version"] == PROFILE_VERSION
    assert any(e["key"] == "country" for e in r["profile"]["stats"]["catalog"])
    assert profile_next_dataset(db, settings) is False  # up to date now


def test_failed_refresh_keeps_the_old_profile_once(
    client, db, settings, synthetic_reader, monkeypatch
):
    ds = upload(client).json()
    profile_next_dataset(db, settings)
    old = {"version": PROFILE_VERSION - 1, "stats": {"articles": 6}}
    row = db.get(Dataset, ds["id"])
    row.profile = old
    db.commit()

    def broken(files):
        raise ValueError("boom")

    monkeypatch.setattr("app.worker.read_wos_files", broken)
    assert profile_next_dataset(db, settings) is True
    r = client.get(f"/api/datasets/{ds['id']}/profile").json()
    assert r["status"] == "ready" and r["profile"]["stats"] == old["stats"]
    assert profile_next_dataset(db, settings) is False  # not retried every iteration


# ------------------------------------------------------------------ records (REQ-REC)


def _records(client, dataset_id, filters=None, **params):
    if filters is not None:
        params["filters"] = json.dumps(
            [{"column": c, "op": op, "value": v} for c, op, v in filters]
        )
    r = client.get(f"/api/datasets/{dataset_id}/records", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _uts(page):
    return [row["values"]["UT (Unique WOS ID)"] for row in page["rows"]]


def _profiled(client, db, settings, monkeypatch, df):
    monkeypatch.setattr("app.worker.read_wos_files", lambda files: df)
    ds = upload(client).json()
    assert profile_next_dataset(db, settings) is True
    return ds["id"]


def _articles(n):
    return pd.DataFrame(
        {
            "UT (Unique WOS ID)": [f"WOS:{i}" for i in range(n)],
            "Article Title": [f"Title {i}" for i in range(n)],
            "Source Title": ["Even journal" if i % 2 == 0 else "Odd journal" for i in range(n)],
        }
    )


def test_profiling_makes_records_available(client, db, settings, synthetic_reader):
    ds = upload(client).json()
    pending = _records(client, ds["id"])
    assert pending["status"] == "pending" and pending["rows"] == [] and pending["total"] == 0

    profile_next_dataset(db, settings)
    page = _records(client, ds["id"])
    assert page["status"] == "ready" and page["error"] is None
    assert page["total"] == page["matching"] == 6
    assert _uts(page) == [f"WOS:{i}" for i in range(1, 7)]
    assert [row["index"] for row in page["rows"]] == list(range(6))
    columns = {c["name"]: c for c in page["columns"]}
    assert columns["Institutions (parsed)"]["derived"] is True
    assert columns["Keywords (normalized)"]["derived"] is True
    assert columns["Publication Year"] == {
        "name": "Publication Year",
        "derived": False,
        "type": "number",
    }
    assert page["rows"][0]["values"]["Institutions (parsed)"] == "Univ Parma; Mayo Clin"

    record = client.get(f"/api/datasets/{ds['id']}/records/0").json()
    assert record["values"]["Addresses"].startswith("[Rossi, Anna; Bianchi, Marco]")
    assert client.get(f"/api/datasets/{ds['id']}/records/99").status_code == 404


def test_profile_refresh_adds_records_to_older_datasets(client, db, settings, synthetic_reader):
    ds = upload(client).json()
    profile_next_dataset(db, settings)
    # As it was before records existed: an older profile and no records.
    db.execute(delete(DatasetRecord).where(DatasetRecord.dataset_id == ds["id"]))
    row = db.get(Dataset, ds["id"])
    row.profile = {**row.profile, "version": RECORDS_SINCE_VERSION - 1}
    db.commit()
    assert _records(client, ds["id"])["status"] == "pending"

    assert profile_next_dataset(db, settings) is True  # the worker's profile refresh
    page = _records(client, ds["id"])
    assert page["status"] == "ready" and page["total"] == 6
    assert db.get(Dataset, ds["id"]).profile_status == "ready"


def test_records_are_private(make_client, client, db, settings, synthetic_reader):
    ds = upload(client).json()
    profile_next_dataset(db, settings)
    bob = make_client()
    register(bob, "bob@example.org")
    assert bob.get(f"/api/datasets/{ds['id']}/records").status_code == 404
    assert bob.get(f"/api/datasets/{ds['id']}/records/0").status_code == 404
    assert client.get(f"/api/datasets/{ds['id']}/records").status_code == 200


def test_records_are_paginated(client, db, settings, monkeypatch):
    ds = _profiled(client, db, settings, monkeypatch, _articles(120))
    first = _records(client, ds, columns=["UT (Unique WOS ID)", "Source Title", "Nope"])
    assert first["page"] == 1 and first["page_size"] == 50
    assert first["total"] == first["matching"] == 120
    assert len(first["rows"]) == 50 and _uts(first)[0] == "WOS:0"
    assert set(first["rows"][0]["values"]) == {"UT (Unique WOS ID)", "Source Title"}

    last = _records(client, ds, page=3, columns=["UT (Unique WOS ID)"])
    assert _uts(last) == [f"WOS:{i}" for i in range(100, 120)]
    assert _records(client, ds, page=4)["rows"] == []
    every = _records(client, ds)["rows"][0]["values"]  # no column list: all of them
    assert set(every) == {"UT (Unique WOS ID)", "Article Title", "Source Title"}
    bad = client.get(f"/api/datasets/{ds}/records", params={"filters": "[{]"})
    assert bad.status_code == 422


def test_records_sort_by_a_column(client, db, settings, monkeypatch):
    df = pd.DataFrame(
        {
            "UT (Unique WOS ID)": ["WOS:0", "WOS:1", "WOS:2", "WOS:3", "WOS:4"],
            "Article Title": ["beta", None, "Alpha", "gamma", "  "],
            "Publication Year": [2020, 999, np.nan, 10000, 2020],
        }
    )
    ds = _profiled(client, db, settings, monkeypatch, df)
    by = lambda col, order: _uts(_records(client, ds, sort=col, order=order))
    # Case-insensitive; empty values last in both directions, ties in upload order.
    assert by("Article Title", "asc") == ["WOS:2", "WOS:0", "WOS:3", "WOS:1", "WOS:4"]
    assert by("Article Title", "desc") == ["WOS:3", "WOS:0", "WOS:2", "WOS:1", "WOS:4"]
    # Publication Year as a number, not as text ("10000" < "2020" < "999").
    assert by("Publication Year", "asc") == ["WOS:1", "WOS:0", "WOS:4", "WOS:3", "WOS:2"]
    assert by("Publication Year", "desc") == ["WOS:3", "WOS:0", "WOS:4", "WOS:1", "WOS:2"]
    # No sort (or an unknown column): upload order.
    assert _uts(_records(client, ds)) == [f"WOS:{i}" for i in range(5)]
    assert _uts(_records(client, ds, sort="Nope")) == [f"WOS:{i}" for i in range(5)]


def test_record_filters_or_within_a_row_and_across_rows(client, db, settings, synthetic_reader):
    ds = upload(client).json()["id"]
    profile_next_dataset(db, settings)
    inst = "Institutions (parsed)"
    kw = "Author Keywords"

    # ";" = OR within a row, terms trimmed and case-insensitive.
    either = _records(client, ds, [(inst, "contains", " PARMA ;  fudan ")])
    assert _uts(either) == ["WOS:1", "WOS:2", "WOS:5", "WOS:6"]
    # Rows = AND.
    both = _records(
        client, ds, [(inst, "contains", "parma; fudan"), (kw, "contains", "ultrasound")]
    )
    assert _uts(both) == ["WOS:1", "WOS:2"]
    # "does not contain a; b": contains neither.
    neither = _records(client, ds, [(inst, "not_contains", "parma; fudan")])
    assert _uts(neither) == ["WOS:3", "WOS:4"]
    # Empty terms are dropped; a row with none filters nothing.
    assert _uts(_records(client, ds, [(kw, "contains", "citespace;; ")])) == ["WOS:4", "WOS:5"]
    assert _records(client, ds, [(kw, "contains", " ; ")])["matching"] == 6


def test_record_filters_apply_to_all_records(client, db, settings, monkeypatch):
    df = _articles(120)
    df.loc[df.index % 10 == 0, "Article Title"] = None
    ds = _profiled(client, db, settings, monkeypatch, df)

    odd = _records(client, ds, [("Source Title", "contains", "odd")])
    assert odd["total"] == 120 and odd["matching"] == 60
    assert _uts(odd)[:3] == ["WOS:1", "WOS:3", "WOS:5"]
    assert _uts(_records(client, ds, [("Source Title", "contains", "odd")], page=2))[-1] == (
        "WOS:119"
    )
    past = _records(client, ds, [("Source Title", "contains", "odd")], page=3)
    assert past["rows"] == [] and past["matching"] == 60  # counted past the last page too
    assert _records(client, ds, [("Article Title", "is_empty", "")])["matching"] == 12
    assert _records(client, ds, [("Article Title", "not_empty", "x")])["matching"] == 108
    none = _records(client, ds, [("Source Title", "contains", "no such journal")])
    assert none["matching"] == 0 and none["rows"] == []

    unknown = _records(client, ds, [("Funding Orgs", "contains", "nih")])
    assert unknown["ignored_filter_columns"] == ["Funding Orgs"]
    assert unknown["matching"] == 120  # the unknown filter is dropped


def test_has_item_matches_whole_items_only(client, db, settings, monkeypatch):
    df = pd.DataFrame(
        {
            "UT (Unique WOS ID)": ["WOS:0", "WOS:1", "WOS:2"],
            "Author Keywords": ["Machine-Learning; Ethics", "deep learning", None],
            "Keywords Plus": [None, "MACHINE LEARNING", "learning"],
            "Source Title": ["Machine Learning Journal", "Learning", "Other"],
            "Author Full Names": ["Rossi, Anna; Lee, Kim", "Rossi, Annabel", "Lee, Kim"],
        }
    )
    ds = _profiled(client, db, settings, monkeypatch, df)
    has = lambda col, value: _uts(_records(client, ds, [(col, "has_item", value)]))

    assert has("Author Keywords", "learning") == []  # not part of "machine learning"
    assert has("Author Keywords", "machine learning") == ["WOS:0"]  # "Machine-Learning"
    assert has("Keywords Plus", "Machine-Learning") == ["WOS:1"]
    assert has("Keywords (normalized)", "machine learning; nope") == ["WOS:0", "WOS:1"]
    assert has("Keywords (normalized)", "learning") == ["WOS:2"]
    # A column without ";": the whole cell is the one item.
    assert has("Source Title", "learning") == ["WOS:1"]
    assert has("Author Full Names", " rossi, anna ") == ["WOS:0"]
    assert has("Author Full Names", "lee, kim") == ["WOS:0", "WOS:2"]


def _nul_df():
    df = synthetic_wos_df()
    df.loc[0, "Article Title"] = "Broken\x00title"
    return df


def test_records_drop_nul_characters(client, db, settings, monkeypatch):
    """A NUL character (PostgreSQL text and JSONB reject it) doesn't stop a file from
    being profiled: it is dropped from the profile and the records."""
    df = _nul_df().rename(columns={"Source Title": "Source\x00Title"})
    ds = _profiled(client, db, settings, monkeypatch, df)
    assert db.get(Dataset, ds).profile_status == "ready"
    page = _records(client, ds)
    assert page["status"] == "ready" and page["total"] == 6
    first = page["rows"][0]["values"]
    assert first["Article Title"] == "Brokentitle" and first["SourceTitle"] == "Journal of Tests"
    assert "SourceTitle" in {c["name"] for c in page["columns"]}
    profile = client.get(f"/api/datasets/{ds}/profile").json()["profile"]
    assert "Brokentitle" in json.dumps(profile) and "\\u0000" not in json.dumps(profile)


def _unstorable(df):
    """Records PostgreSQL rejects (NUL in JSONB), past pipeline.records' cleaning."""
    return [{"Article Title": "Broken\x00title"}]


def test_unstorable_upload_fails_and_the_worker_moves_on(client, db, settings, monkeypatch):
    """A failure while storing (here records PostgreSQL rejects) marks the dataset failed
    instead of leaving it pending forever."""
    monkeypatch.setattr("app.worker.read_wos_files", lambda files: synthetic_wos_df())
    monkeypatch.setattr("app.worker.dataset_records", _unstorable)
    ds = upload(client).json()
    created = client.post("/api/runs", json={"dataset_id": ds["id"], "relation": "author"})
    assert created.status_code == 202

    assert run_once(db, settings) is True
    db.expire_all()
    row = db.get(Dataset, ds["id"])
    assert row.profile_status == "failed" and row.profile_error
    assert db.scalar(select(func.count()).where(DatasetRecord.dataset_id == ds["id"])) == 0
    page = _records(client, ds["id"])
    assert page["status"] == "failed" and page["rows"] == []
    # The same iteration claimed the queued run: the queue isn't stuck behind it.
    run = client.get(f"/api/runs/{created.json()['id']}").json()
    assert run["status"] in ("succeeded", "failed")
    assert profile_next_dataset(db, settings) is False  # not picked again


def test_unstorable_refresh_is_remembered(client, db, settings, monkeypatch):
    monkeypatch.setattr("app.worker.read_wos_files", lambda files: synthetic_wos_df())
    ds = upload(client).json()
    profile_next_dataset(db, settings)
    db.execute(delete(DatasetRecord).where(DatasetRecord.dataset_id == ds["id"]))
    row = db.get(Dataset, ds["id"])
    row.profile = {**row.profile, "version": RECORDS_SINCE_VERSION - 1}
    db.commit()

    monkeypatch.setattr("app.worker.dataset_records", _unstorable)
    assert profile_next_dataset(db, settings) is True  # the refresh fails while storing
    db.expire_all()
    row = db.get(Dataset, ds["id"])
    assert row.profile_status == "ready"
    assert row.profile["refresh_failed_version"] == PROFILE_VERSION
    assert row.profile["version"] == RECORDS_SINCE_VERSION - 1  # the old profile is kept
    page = _records(client, ds["id"])
    assert page["status"] == "failed" and "could not be read" in page["error"]
    assert profile_next_dataset(db, settings) is False  # not retried every iteration


def test_record_filters_are_bounded(client, db, settings, synthetic_reader, monkeypatch):
    ds = upload(client).json()["id"]
    profile_next_dataset(db, settings)
    many = "; ".join(f"term {i}" for i in range(51))

    def get(**params):
        return client.get(f"/api/datasets/{ds}/records", params=params)

    too_many = get(filters=json.dumps([{"column": "Addresses", "op": "contains", "value": many}]))
    assert too_many.status_code == 422
    assert too_many.json()["detail"] == 'A filter can have at most 50 terms separated by ";".'
    fifty = "; ".join(f"t{i}" for i in range(50))
    over_total = [{"column": "Addresses", "op": "not_contains", "value": fifty}] * 5
    r = get(filters=json.dumps(over_total))
    assert (
        r.status_code == 422
        and r.json()["detail"] == "The filters can have at most 200 terms in all."
    )
    # Repeated terms count once.
    repeated = "; ".join(["parma"] * 80)
    ok = get(filters=json.dumps([{"column": "Addresses", "op": "contains", "value": repeated}]))
    assert ok.status_code == 200 and ok.json()["matching"] == 2
    assert get(columns=[f"c{i}" for i in range(301)]).status_code == 422

    # A query that runs past the statement timeout is cancelled with a readable message.
    from sqlalchemy import text

    monkeypatch.setattr("app.services.records.STATEMENT_TIMEOUT_MS", 50)
    monkeypatch.setattr(
        "app.services.records._contains", lambda column, values: text("pg_sleep(0.5) IS NULL")
    )
    slow = get(filters=json.dumps([{"column": "Addresses", "op": "contains", "value": "x"}]))
    assert slow.status_code == 422
    assert slow.json()["detail"].startswith("These filters take too long")
    assert get().status_code == 200  # the next request is unaffected


def test_contains_on_keyword_columns_treats_hyphens_as_spaces(client, db, settings, monkeypatch):
    df = pd.DataFrame(
        {
            "UT (Unique WOS ID)": ["WOS:0", "WOS:1", "WOS:2"],
            "Keywords Plus": ["MACHINE-LEARNING; NEURAL NETS", "deep learning", None],
            "Author Keywords": ["self\u2013supervised", "Self-supervised learning", "ethics"],
            "Article Title": ["A machine-learning study", "Other", "Ethics of AI"],
        }
    )
    ds = _profiled(client, db, settings, monkeypatch, df)
    flt = lambda col, op, value: _uts(_records(client, ds, [(col, op, value)]))

    # As the keyword networks compare them: case and hyphens don't matter.
    assert flt("Keywords Plus", "contains", "machine learning") == ["WOS:0"]
    assert flt("Keywords Plus", "contains", "Machine-Learning; deep") == ["WOS:0", "WOS:1"]
    # WOS:0 is "self–supervised" (en dash): a typographic dash counts as a hyphen.
    assert flt("Author Keywords", "contains", "self supervised") == ["WOS:0", "WOS:1"]
    assert flt("Keywords (normalized)", "contains", "machine-learning") == ["WOS:0"]
    assert flt("Keywords Plus", "not_contains", "machine learning") == ["WOS:1", "WOS:2"]
    # Other columns are unchanged: a hyphen is a hyphen.
    assert flt("Article Title", "contains", "machine learning") == []
    assert flt("Article Title", "contains", "machine-learning") == ["WOS:0"]


def test_ui_unaccent_table_matches_the_database(db):
    """The Records highlight (frontend/src/lib/unaccent.generated.ts) folds as this
    database's unaccent does; regenerate the table when the PostgreSQL image changes."""
    generated = Path(__file__).parents[3] / "frontend/src/lib/unaccent.generated.ts"
    entry = re.compile(r"""^\s+(?:"(.+?)"|([^\s"']+)): ((?:"|').*(?:"|')),$""")
    table = {
        (m[1] or m[2]): ast.literal_eval(m[3])
        for line in generated.read_text(encoding="utf-8").splitlines()
        if (m := entry.match(line))
    }
    header = re.search(r"(\d+) rules\.", generated.read_text(encoding="utf-8"))
    assert header and len(table) == int(header[1]) > 1000
    sources = list(table)
    folded = db.execute(
        text(
            "SELECT unaccent(s) FROM unnest(CAST(:s AS text[])) WITH ORDINALITY AS t(s, n) ORDER BY n"
        ),
        {"s": sources},
    ).scalars()
    assert dict(zip(sources, folded)) == table


def test_record_filters_ignore_accents_and_case(client, db, settings, monkeypatch):
    uts = [f"WOS:{i}" for i in range(8)]
    df = pd.DataFrame(
        {
            "UT (Unique WOS ID)": uts,
            # The only "i" of WOS:0, 2, 3, 4 and 6 is accented; WOS:7 has a plain one.
            "Addresses": [
                "Ísland",
                "Lyngby, Dänemark",
                "İstanbul",
                "Ìsola",
                "Málaga, ÍSLA",
                "Oslo 50%",
                "Mérída",
                "Pisa",
            ],
            "Author Full Names": ["Núñez, José", "Nunez, Jose", "Øster, Åsa"] + [None] * 5,
            "Author Keywords": ["Ál-Gebra", "SÉLF-SUPERVISED learning", None, "İ-Tech"]
            + [None] * 4,
        }
    )
    ds = _profiled(client, db, settings, monkeypatch, df)
    flt = lambda col, op, value: _uts(_records(client, ds, [(col, op, value)]))

    # "i" and "I" match every accented i; accented terms match a plain "i".
    every_i = ["WOS:0", "WOS:2", "WOS:3", "WOS:4", "WOS:6", "WOS:7"]
    for term in ["i", "I", "Í", "İ", "í", "ì"]:
        assert flt("Addresses", "contains", term) == every_i, term
    assert flt("Addresses", "contains", "istanbul") == ["WOS:2"]
    assert flt("Addresses", "contains", "İSTANBUL") == ["WOS:2"]
    assert flt("Addresses", "contains", "island; danemark") == ["WOS:0", "WOS:1"]
    # Typed text, not LIKE patterns.
    assert flt("Addresses", "contains", "0%") == ["WOS:5"]
    assert flt("Addresses", "contains", "_; \\; a%") == []
    assert flt("Addresses", "contains", "\u0301") == uts  # folds to nothing: ignored
    # "does not contain i" also drops the cells whose only "i" is accented.
    assert flt("Addresses", "not_contains", "i") == ["WOS:1", "WOS:5"]
    assert flt("Addresses", "not_contains", "Í") == ["WOS:1", "WOS:5"]
    # On every column, and for "has item" too.
    assert flt("Author Full Names", "contains", "nunez") == ["WOS:0", "WOS:1"]
    assert flt("Author Full Names", "has_item", "NÚÑEZ, JOSÉ") == ["WOS:0", "WOS:1"]
    assert flt("Author Full Names", "has_item", "oster, asa") == ["WOS:2"]
    # Keyword columns: hyphens still count as spaces, accents and case are ignored.
    assert flt("Author Keywords", "contains", "al gebra") == ["WOS:0"]
    assert flt("Author Keywords", "contains", "self supervised") == ["WOS:1"]
    assert flt("Author Keywords", "has_item", "Al-Gebra") == ["WOS:0"]
    assert flt("Author Keywords", "has_item", "i tech") == ["WOS:3"]
    assert flt("Keywords (normalized)", "has_item", "İ-TECH; al gebra") == ["WOS:0", "WOS:3"]
    assert flt("Keywords (normalized)", "contains", "ál") == ["WOS:0"]
