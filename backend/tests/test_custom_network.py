"""Custom networks (pipeline.custom): catalog, models, graph, and parity with the presets."""

import dataclasses
import typing

import pandas as pd
import pytest

from app.schemas.api import EntityName, LinkName, ModelName
from pipeline import custom
from pipeline.custom import (
    CustomParams,
    NetworkBuildError,
    availability,
    build_custom_graph,
    character_similarity,
    combination_problem,
    custom_network,
    word_matching,
    word_overlap,
)
from pipeline.institutions import prepare_article_institution_data
from pipeline.networks import create_institution_keyword_network
from pipeline.relations import build_author_graph, prepare_articles

from .fixtures.synthetic_wos import synthetic_wos_df


def _weights(G):
    return {tuple(sorted((u, v))): d["weight"] for u, v, d in G.edges(data=True)}


def test_api_names_match_the_catalog():
    assert typing.get_args(EntityName) == tuple(custom.ENTITIES)
    assert typing.get_args(LinkName) == tuple(custom.LINKS)
    assert typing.get_args(ModelName) == tuple(custom.MODELS)
    assert set(custom.MODEL_DESCRIPTIONS) == set(custom.MODELS)


# ------------------------------------------------------------------ parity with the presets


def test_author_same_article_reproduces_co_authorship():
    articles = prepare_articles(synthetic_wos_df())
    preset = build_author_graph(articles)
    G = build_custom_graph(articles, CustomParams(entity="author", link="same_article"))
    assert set(G) == set(preset)
    expected = _weights(preset)
    got = _weights(G)
    assert set(got) == set(expected)
    # The preset counts an article twice when it lists an author twice; here an
    # article is one shared paper. Every other weight is equal.
    differ = {k for k in got if got[k] != expected[k]}
    assert all(expected[k] == got[k] + 1 for k in differ) and len(differ) <= 2


@pytest.mark.parametrize(("min_shared", "max_df"), [(2, 0.5), (3, 0.12), (1, 0.9)])
def test_corresponding_institution_keywords_reproduces_the_preset(min_shared, max_df):
    articles = prepare_articles(synthetic_wos_df())
    articles = articles[articles["Document Type"].isin(("Article", "Review"))]
    preset = create_institution_keyword_network(
        prepare_article_institution_data(articles),
        max_keyword_df=max_df,
        min_shared_keywords=min_shared,
    )
    G = build_custom_graph(
        articles,
        CustomParams(
            entity="corresponding_institution",
            link="keywords",
            min_shared=min_shared,
            max_item_df=max_df,
        ),
    )
    assert set(G) == set(preset)
    assert _weights(G) == _weights(preset)


# ------------------------------------------------------------------ models


def test_word_matching_counts_shared_items_and_drops_common_ones():
    values = [["AI", "Ethics", "Law"], ["ai", "ethics", "law"], ["AI", "Vision"], ["Vision"]]
    # "ai" is in 3 of 4 articles (75%): above 0.5, so it is ignored.
    pairs = word_matching(values, min_shared=2, max_item_df=0.5)
    assert pairs == {(0, 1): {"ethics", "law"}}
    assert set(word_matching(values, min_shared=1, max_item_df=0.5)) == {(0, 1), (2, 3)}


def test_word_overlap_uses_jaccard_on_words_without_stop_words():
    values = [
        ["Deep learning for tumour detection"],
        ["Tumour detection with deep learning"],
        ["Deep learning for traffic"],
        [],
    ]
    # 0 vs 1: {deep, learning, tumour, detection} on both sides -> 1.0.
    # 0 vs 2: {deep, learning} / {deep, learning, tumour, detection, traffic} -> 0.4.
    assert set(word_overlap(values, threshold=0.9, max_word_df=1.0)) == {(0, 1)}
    assert set(word_overlap(values, threshold=0.4, max_word_df=1.0)) == {(0, 1), (0, 2), (1, 2)}


def test_word_overlap_needs_a_rare_shared_word():
    values = [["Deep learning A"], ["Deep learning B"], ["Deep learning C"]]
    # deep/learning are in every article: with max 50% they never make candidates.
    assert word_overlap(values, threshold=0.1, max_word_df=0.5) == {}


def test_character_similarity_catches_spelling_variants():
    values = [["Univ Toronto"], ["University of Toronto"], ["Toronto Metropolitan Univ"]]
    pairs = character_similarity(values, threshold=0.7, max_word_df=1.0)
    assert set(pairs) == {(0, 1)}
    assert pairs[(0, 1)] == {"Univ Toronto ~ University of Toronto"}


def test_identical_strings_always_match():
    values = [["HEALTHCARE"], ["Healthcare"], ["Other Journal"]]
    for model in (word_overlap, character_similarity):
        assert set(model(values, threshold=0.99, max_word_df=0.01)) == {(0, 1)}


def test_too_many_pairs_fail_with_a_message(monkeypatch):
    monkeypatch.setattr(custom, "MAX_ARTICLE_PAIRS", 2)
    values = [["x", "y"]] * 4  # 6 pairs
    with pytest.raises(NetworkBuildError, match="more than 2 pairs"):
        word_matching(values, min_shared=1, max_item_df=1.0)


# ------------------------------------------------------------------ catalog rules


@pytest.mark.parametrize(
    ("entity", "link", "model", "problem"),
    [
        ("institution", "keywords", "word_matching", None),
        ("institution", "article_title", "character_similarity", None),
        ("institution", "abstract", "character_similarity", "Abstract can be compared with"),
        ("institution", "keywords", "word_overlap", "can be compared with"),
        ("journal", "journal", "word_overlap", "can't be linked by its own field"),
        ("author", "authors", "word_matching", "can't be linked by its own field"),
        ("journal", "same_article", "word_matching", "one value per article"),
        ("planet", "keywords", "word_matching", "Unknown entity"),
    ],
)
def test_combination_rules(entity, link, model, problem):
    result = combination_problem(entity, link, model)
    if problem is None:
        assert result is None
    else:
        assert result and problem in result


def test_availability_follows_column_fill():
    fill = {"Funding Orgs": 5.0, "Author Keywords": 90.0, "Keywords Plus": 0.0, "Addresses": 99}
    result = availability(fill)
    assert result["entities"]["institution"] is None
    assert "only 5%" in result["entities"]["funder"]
    assert "empty or missing" in result["entities"]["organization"]
    assert result["links"]["keywords"] is None  # one of its two columns is enough
    assert "empty or missing" in result["links"]["keywords_plus"]


# ------------------------------------------------------------------ networks


def test_every_combination_the_synthetic_data_supports_builds_a_valid_network():
    articles = prepare_articles(synthetic_wos_df())
    built = 0
    for entity, espec in custom.ENTITIES.items():
        for link, lspec in custom.LINKS.items():
            for model in lspec.models:
                if combination_problem(entity, link, model):
                    continue
                if any(c not in articles for c in espec.columns) or not any(
                    c in articles for c in lspec.columns
                ):
                    continue
                params = CustomParams(
                    entity=entity, link=link, model=model, max_item_df=1.0, max_word_df=1.0
                )
                network = custom_network(articles, params)  # validates the JSON contract
                assert all(e["type"] == lspec.edge_type for e in network["edges"])
                built += 1
    assert built >= 15


def test_nodes_carry_article_counts_and_edges_their_evidence():
    articles = prepare_articles(synthetic_wos_df())
    network = custom_network(
        articles, CustomParams(entity="country", link="keywords", min_shared=1, max_item_df=1.0)
    )
    assert all(n["attr"]["articles"] >= 1 for n in network["nodes"])
    assert network["edges"] and all(e["attr"]["evidence"] for e in network["edges"])


def test_missing_columns_raise_key_error():
    articles = prepare_articles(synthetic_wos_df())
    with pytest.raises(KeyError, match="Funding Orgs"):
        build_custom_graph(articles, CustomParams(entity="funder", link="keywords"))


def test_invalid_combination_is_refused_before_reading_data():
    with pytest.raises(NetworkBuildError, match="own field"):
        build_custom_graph(
            pd.DataFrame(), CustomParams(entity="journal", link="journal", model="word_overlap")
        )


def test_params_are_a_frozen_dataclass_like_the_presets():
    assert dataclasses.is_dataclass(CustomParams)
    with pytest.raises(dataclasses.FrozenInstanceError):
        CustomParams().entity = "author"  # type: ignore[misc]


def test_funders_drop_grant_numbers_and_entries_that_are_only_a_grant():
    assert custom._funders("NIH [R01 123]; [2020-45]; NSF;  nih ") == ["NIH", "NSF"]


def test_min_weight_drops_weak_links_but_keeps_nodes():
    articles = prepare_articles(synthetic_wos_df())
    base = CustomParams(entity="country", link="keywords", min_shared=1, max_item_df=1.0)
    G1 = build_custom_graph(articles, base)
    weights = [w for _, _, w in G1.edges(data="weight")]
    cut = max(weights)
    G2 = build_custom_graph(articles, dataclasses.replace(base, min_weight=cut))
    assert set(G2) == set(G1)
    assert all(w >= cut for _, _, w in G2.edges(data="weight"))
    assert G2.number_of_edges() == sum(1 for w in weights if w >= cut) < G1.number_of_edges()
