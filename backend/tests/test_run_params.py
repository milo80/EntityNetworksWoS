"""The API's run parameters must stay in sync with the pipeline (no database needed)."""

import dataclasses

import pytest

from app.schemas.api import PARAMS_BY_RELATION
from app.services.runs import build_network
from pipeline.relations import (
    RELATIONS,
    author_network,
    institution_keyword_network,
    prepare_articles,
)
from pipeline.schema import validate_network

from .fixtures.synthetic_wos import synthetic_wos_df


@pytest.mark.parametrize("relation", sorted(RELATIONS))
def test_api_defaults_match_pipeline_defaults(relation):
    _, params_cls = RELATIONS[relation]
    api_defaults = PARAMS_BY_RELATION[relation]().model_dump()
    assert api_defaults.pop("max_authors") == 15  # prepare_articles() default
    pipeline_defaults = dataclasses.asdict(params_cls())
    for key, value in api_defaults.items():
        assert pipeline_defaults[key] == value, key


def test_relations_known_to_api_and_pipeline_agree():
    assert set(PARAMS_BY_RELATION) == set(RELATIONS)


def test_synthetic_data_builds_valid_networks():
    articles = prepare_articles(synthetic_wos_df())
    author = author_network(articles)
    validate_network(author)
    ids = {n["id"] for n in author["nodes"]}
    assert "0000-0001-0000-0001" in ids  # ORCID resolved
    assert all(e["source"] != e["target"] for e in author["edges"])  # duplicated author ignored

    inst = institution_keyword_network(
        articles, dataclasses.replace(RELATIONS["institution_keywords"][1](),
                                      max_keyword_df=0.5, min_shared_keywords=2))
    assert inst["edges"], "synthetic data should produce keyword links"


def test_build_network_applies_api_params(monkeypatch):
    monkeypatch.setattr("app.services.runs.read_wos_files", lambda files: synthetic_wos_df())
    net = build_network("author", {"max_authors": 2, "top_n": 10}, [])
    # Only 2-author articles survive max_authors=2.
    assert {e["attr"]["article_titles"][0] for e in net["edges"]} == {
        "Synthetic article WOS:2", "Synthetic article WOS:3", "Synthetic article WOS:5"}
