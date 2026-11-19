import json

import numpy as np
import pandas as pd

from pipeline.profile import SAMPLE_ROWS, profile_dataset

from .fixtures.synthetic_wos import synthetic_wos_df


def test_profile_of_synthetic_dataset():
    df = synthetic_wos_df()
    p = profile_dataset(df)
    json.dumps(p, allow_nan=False)  # strictly JSON-serializable

    stats = p["stats"]
    assert stats["articles"] == 6 and stats["columns"] == len(df.columns)
    assert stats["unique_article_ids"] == 6 and stats["duplicate_article_ids"] == 0
    assert stats["publication_years"]["min"] == stats["publication_years"]["max"] == 2025
    assert stats["document_types"] == [{"value": "Article", "count": 6}]
    assert stats["authors"]["mentions"] == 16  # "Hu, Zhixi" counted twice, as listed
    assert stats["authors"]["unique_names"] == 9
    assert stats["authors"]["per_article"]["max"] == 4
    assert stats["articles_with_orcid_pct"] == round(100 * 4 / 6, 1)
    top_kw = stats["keywords"]["author_keywords"]["top"][:2]
    assert sorted(k["value"] for k in top_kw) == ["deep learning", "fetal ultrasound"]
    assert all(k["count"] == 3 for k in top_kw)
    assert stats["keywords"]["keywords_plus"]["articles_with_pct"] == 0.0
    assert stats["corresponding_author"] == {"resolved_pct": 100.0}

    # Node catalog: every custom-network node type the columns allow (article
    # excluded), counted once per article.
    catalog = {e["key"]: e for e in stats["catalog"]}
    assert list(catalog) == [
        "author",
        "institution",
        "corresponding_institution",
        "country",
        "journal",
    ]
    assert catalog["country"]["granularity"] == "coarse"
    assert {e["granularity"] for k, e in catalog.items() if k != "country"} == {"fine"}
    assert {c["value"]: c["count"] for c in catalog["country"]["top"]} == {
        "USA": 3,
        "Peoples R China": 3,
        "Italy": 2,
    }
    # "Hu, Zhixi" is listed twice on one article but counted once there.
    assert catalog["author"]["distinct"] == 9 and catalog["author"]["articles_with_pct"] == 100.0
    assert max(c["count"] for c in catalog["author"]["top"]) == 2
    assert catalog["journal"]["top"] == [{"value": "Journal of Tests", "count": 6}]

    # Link catalog: every field a custom network can link by.
    links = {e["key"]: e for e in stats["link_catalog"]}
    assert links["same_article"] == {
        "key": "same_article",
        "label": "Same article (co-occurrence)",
        "kind": "same_article",
        "models": [],
        "articles_with_pct": 100.0,
    }
    kw = links["author_keywords"]
    assert kw["kind"] == "list" and kw["same_as_node"] is None
    assert {t["value"] for t in kw["top"][:2]} == {"deep learning", "fetal ultrasound"}
    # A list field on a node type's column points to that node card instead.
    assert links["authors"]["same_as_node"] == "author" and links["authors"]["top"] == []
    assert links["authors"]["distinct"] == 9
    assert links["article_title"]["kind"] == "string"
    assert links["article_title"]["median_words"] == 3  # "Synthetic article WOS:1"
    assert "keywords_plus" in links and links["keywords_plus"]["articles_with_pct"] == 0.0

    schema = {c["name"]: c for c in p["schema"]}
    assert schema["Publication Year"]["type"] == "number"
    assert schema["Keywords Plus"]["non_empty"] == 0 and schema["Keywords Plus"]["example"] is None
    assert schema["Author Full Names"]["non_empty_pct"] == 100.0

    assert p["sample"]["columns"] == list(df.columns)
    assert len(p["sample"]["rows"]) == 6 <= SAMPLE_ROWS


def test_profile_cells_are_json_safe_and_truncated():
    df = pd.DataFrame(
        {
            "a": [np.int64(3), np.nan],
            "b": ["x" * 500, None],
            "c": [np.float64(1.5), np.float64("nan")],
        }
    )
    p = profile_dataset(df)
    json.dumps(p, allow_nan=False)
    row0, row1 = p["sample"]["rows"]
    assert row0[0] == 3.0 and type(row0[0]) is float  # numpy scalar -> plain Python float
    assert row0[2] == 1.5 and type(row0[2]) is float
    assert len(row0[1]) == 201 and row0[1].endswith("…")
    assert row1 == [None, None, None]


def test_profile_tolerates_missing_wos_columns():
    p = profile_dataset(pd.DataFrame({"Title": ["one", "two"]}))
    assert p["stats"] == {"articles": 2, "columns": 1, "catalog": [], "link_catalog": []}
    assert p["schema"][0]["distinct"] == 2


def test_frontend_profile_fixture_is_current():
    """frontend/src/test/synthetic_profile.json mirrors this output for UI tests."""
    from pathlib import Path

    fixture = (
        Path(__file__).resolve().parents[2] / "frontend" / "src" / "test" / "synthetic_profile.json"
    )
    assert json.loads(fixture.read_text(encoding="utf-8")) == profile_dataset(synthetic_wos_df()), (
        "regenerate: see the command in frontend/src/test/mockApi.ts"
    )


def test_catalog_skips_node_types_without_their_columns():
    df = synthetic_wos_df().drop(columns=["Addresses"])
    keys = [e["key"] for e in profile_dataset(df)["stats"]["catalog"]]
    assert "institution" not in keys and "country" not in keys
    assert "author" in keys and "journal" in keys
