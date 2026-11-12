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
    countries = {c["value"]: c["count"] for c in stats["corresponding_author"]["top_countries"]}
    assert countries == {"Italy": 2, "USA": 1, "Peoples R China": 3}

    schema = {c["name"]: c for c in p["schema"]}
    assert schema["Publication Year"]["type"] == "number"
    assert schema["Keywords Plus"]["non_empty"] == 0 and schema["Keywords Plus"]["example"] is None
    assert schema["Author Full Names"]["non_empty_pct"] == 100.0

    assert p["sample"]["columns"] == list(df.columns)
    assert len(p["sample"]["rows"]) == 6 <= SAMPLE_ROWS


def test_profile_cells_are_json_safe_and_truncated():
    df = pd.DataFrame({"a": [np.int64(3), np.nan], "b": ["x" * 500, None],
                       "c": [np.float64(1.5), np.float64("nan")]})
    p = profile_dataset(df)
    json.dumps(p, allow_nan=False)
    row0, row1 = p["sample"]["rows"]
    assert row0[0] == 3.0 and type(row0[0]) is float  # numpy scalar -> plain Python float
    assert row0[2] == 1.5 and type(row0[2]) is float
    assert len(row0[1]) == 201 and row0[1].endswith("…")
    assert row1 == [None, None, None]


def test_profile_tolerates_missing_wos_columns():
    p = profile_dataset(pd.DataFrame({"Title": ["one", "two"]}))
    assert p["stats"] == {"articles": 2, "columns": 1}
    assert p["schema"][0]["distinct"] == 2
