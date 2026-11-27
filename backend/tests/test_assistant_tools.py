"""The assistant's platform guide and tools, without a database or the Claude API."""

from __future__ import annotations

import json
from itertools import product

import pytest

from app.models import Dataset, DatasetFile, NetworkRun
from app.schemas.api import CustomParams
from app.services.assistant import guide, tools
from app.services.assistant.guide import SYSTEM_PROMPT, setting_limits
from app.services.assistant.tools import (
    TOOLS,
    Collected,
    ProposeNetworkInput,
    ToolContext,
    ToolFailed,
    check_proposal,
    dataset_metadata,
    network_metadata,
    run_tool,
)
from pipeline import custom
from pipeline.custom import custom_network
from pipeline.profile import profile_dataset
from pipeline.relations import prepare_articles
from pipeline.schema import TEAM_OTHER, TEAM_UNKNOWN

from .fixtures.synthetic_wos import synthetic_wos_df


def _strings(value: object) -> set[str]:
    """Every string in a JSON-like value (dict keys excluded)."""
    if isinstance(value, str):
        return {value}
    if isinstance(value, dict):
        return set().union(*(_strings(v) for v in value.values())) if value else set()
    if isinstance(value, (list, tuple)):
        return set().union(*(_strings(v) for v in value)) if value else set()
    return set()


def _data_values(values: set[str]) -> set[str]:
    """Values from the data that must not leak: long enough to be specific, not
    numbers, and not words of the app's own catalog (e.g. 'Article')."""
    out = set()
    for v in values:
        for part in [v, *v.split(";")]:
            part = part.strip()
            if len(part) >= 4 and not part.replace(".", "").isdigit() and part not in SYSTEM_PROMPT:
                out.add(part)
    return out


# ---------------------------------------------------------------- guide (REQ-AST-1)


def test_platform_guide_covers_every_entity_link_and_model():
    for key, spec in custom.ENTITIES.items():
        assert f'- {key}: "{spec.label}"' in SYSTEM_PROMPT
        allowed = [
            link
            for link, lspec in custom.LINKS.items()
            if any(custom.combination_problem(key, link, m) is None for m in lspec.models)
        ]
        assert f"{key}: can be linked by {', '.join(allowed)}\n" in SYSTEM_PROMPT + "\n"
    for key, spec in custom.LINKS.items():
        assert f'- {key}: "{spec.label}"' in SYSTEM_PROMPT
        if spec.kind != "same_article":  # no model (REQ-AST-6 AC4)
            line = next(
                ln for ln in SYSTEM_PROMPT.splitlines() if ln.startswith(f'- {key}: "{spec.label}"')
            )
            assert f"models: {', '.join(spec.models)};" in line
    for key, label in custom.MODELS.items():
        assert f'- {key}: "{label}". {custom.MODEL_DESCRIPTIONS[key]}' in SYSTEM_PROMPT
    # The rules a custom run applies.
    one_per = [k for k, e in custom.ENTITIES.items() if not e.many_per_article]
    assert f"these have one\n  per article: {', '.join(one_per)}." in SYSTEM_PROMPT
    assert "can't be linked by its own field" in SYSTEM_PROMPT
    assert f"{custom.MIN_FILL_PCT:.0f}% of the articles" in SYSTEM_PROMPT
    # The guide is static: no request or user data in it.
    assert guide.SYSTEM_PROMPT == guide._build()


def test_platform_guide_uses_the_custom_run_limits():
    # The example from the story, spelled out.
    assert "- min_shared: Word matching: shared items needed. Default 3, from 1 to 50." in (
        SYSTEM_PROMPT
    )
    for name in guide.NUMERIC_SETTINGS:
        field = CustomParams.model_fields[name]
        default, low, high, inclusive = setting_limits(name)
        assert default == field.default
        line = next(ln for ln in SYSTEM_PROMPT.splitlines() if ln.startswith(f"- {name}: "))
        assert f"Default {guide._fmt(default)}," in line
        bound = "from {} to {}" if inclusive else "above {}, at most {}"
        assert bound.format(guide._fmt(low), guide._fmt(high)) in line
        # The limits are exactly what a custom run accepts.
        assert CustomParams.model_validate({name: high}).model_dump()[name] == high
        below = low - 1 if inclusive else low
        with pytest.raises(ValueError):
            CustomParams.model_validate({name: below})
        if name in guide.FORM_LABELS:
            assert f'Form: "{guide.FORM_LABELS[name]}"' in line
    assert "Default 0.5" in SYSTEM_PROMPT and "Default threshold for this model: 0.9" in (
        SYSTEM_PROMPT
    )


def test_system_prompt_answers_in_the_users_language():
    assert "Answer in the language the user writes in." in SYSTEM_PROMPT
    assert (
        "Keep the app's names as the app shows them, in\n  English: setting names, form "
        "labels, and entity, link field and model names and keys"
    ) in SYSTEM_PROMPT
    assert "Plain text only" in SYSTEM_PROMPT


def test_tools_are_strict_and_closed():
    for tool in TOOLS:
        assert tool["strict"] is True
        schema = tool["input_schema"]
        assert isinstance(schema, dict)
        assert schema["additionalProperties"] is False
        assert set(schema.get("required", [])) == set(schema["properties"]), tool["name"]


# ---------------------------------------------------------------- proposals (REQ-AST-2)


def _proposal(**overrides) -> ProposeNetworkInput:
    values = {
        "entity": "institution",
        "link": "keywords",
        "model": "word_matching",
        "top_n": 300,
        "min_weight": 1,
        "min_shared": 3,
        "max_item_df": 0.05,
        "threshold": None,
        "max_word_df": None,
    } | overrides
    return ProposeNetworkInput.model_validate(values)


def test_proposal_check_uses_the_custom_run_rules():
    dataset = Dataset(id=7, name="x", profile_status="pending")  # no profile: all offered
    for entity, link, model in product(custom.ENTITIES, custom.LINKS, custom.MODELS):
        args = _proposal(entity=entity, link=link, model=model, threshold=0.5, max_word_df=0.05)
        problem = custom.combination_problem(entity, link, model)
        if problem is None:
            proposal = check_proposal(dataset, args)
            assert (proposal.entity, proposal.link, proposal.model) == (entity, link, model)
            assert proposal.dataset_id == 7
        else:
            with pytest.raises(ToolFailed, match="would refuse") as err:
                check_proposal(dataset, args)
            assert problem in str(err.value)

    # Every value within its range, as a custom run checks it.
    for field, bad in [
        ("min_shared", 0),
        ("min_shared", 51),
        ("max_item_df", 0),
        ("max_item_df", 1.5),
        ("top_n", 9),
        ("top_n", 2001),
        ("min_weight", 0),
        ("min_weight", 1001),
    ]:
        with pytest.raises(ToolFailed, match=field):
            check_proposal(dataset, _proposal(**{field: bad}))
    for field, bad in [("threshold", 0), ("max_word_df", 2)]:
        args = _proposal(link="article_title", model="word_overlap", **{field: bad})
        with pytest.raises(ToolFailed, match=field):
            check_proposal(dataset, args)

    # Only the chosen model's thresholds are kept; a string model without a
    # threshold gets its default.
    p = check_proposal(dataset, _proposal(threshold=0.7, max_word_df=0.2))
    assert (p.min_shared, p.max_item_df, p.threshold, p.max_word_df) == (3, 0.05, None, None)
    p = check_proposal(
        dataset,
        _proposal(
            entity="journal",
            link="article_title",
            model="character_similarity",
            min_shared=4,
            max_word_df=0.1,
        ),
    )
    assert (p.min_shared, p.max_item_df, p.threshold, p.max_word_df) == (None, None, 0.9, 0.1)
    p = check_proposal(dataset, _proposal(entity="author", link="same_article", min_weight=2))
    assert (p.min_shared, p.max_item_df, p.threshold, p.max_word_df) == (None, None, None, None)
    assert (
        p.summary
        == "Author linked by Same article (co-occurrence), links of weight 2 or more, up to 300 nodes"
    )
    assert check_proposal(dataset, _proposal()).summary == (
        "Institution (all authors) linked by Keywords (author keywords + Keywords Plus), "
        "word matching, at least 3 shared, up to 300 nodes"
    )


# ---------------------------------------------------------------- metadata only (REQ-AST-4)


@pytest.fixture(scope="module")
def synthetic_profile():
    return profile_dataset(synthetic_wos_df())


def test_dataset_tool_returns_only_metadata(synthetic_profile):
    dataset = Dataset(
        id=3,
        name="Unpublished cohort Zyxq",
        profile_status="ready",
        profile=synthetic_profile,
        files=[
            DatasetFile(
                original_name="secret_export_zyxq.xls",
                stored_name="a",
                size_bytes=1,
                sha256="0" * 64,
            )
        ],
    )
    meta = dataset_metadata(dataset)
    text = json.dumps(meta, ensure_ascii=False)

    assert meta["articles"] == synthetic_profile["stats"]["articles"]
    entities = {e["key"]: e for e in meta["entities"]}
    assert entities["author"]["available"] is True
    assert entities["funder"]["available"] is False
    assert "Funding Orgs" in entities["funder"]["reason"]  # which field is missing
    assert {lk["key"] for lk in meta["links"]} == set(custom.LINKS)
    assert {"Author Keywords", "country"} <= {a["key"] for a in meta["attributes"]}

    # No dataset or file name, and no value of the data (samples, examples, catalog tops).
    assert "Zyxq" not in text and "zyxq" not in text
    rows = _data_values(_strings(synthetic_profile["sample"]["rows"]))
    assert "Rossi, Anna" in rows  # the check below has something to find
    leaks = [v for v in rows if v in text]
    leaks += [
        v
        for v in _data_values({str(c.get("example", "")) for c in synthetic_profile["schema"]})
        if v in text
    ]
    leaks += [
        v
        for v in _data_values(
            {t["value"] for e in synthetic_profile["stats"]["catalog"] for t in e.get("top", [])}
        )
        if v in text
    ]
    assert leaks == []


def test_network_tool_returns_only_metadata():
    params = CustomParams(entity="institution", link="keywords", min_shared=1, max_item_df=1)
    network = custom_network(prepare_articles(synthetic_wos_df()), params)
    run = NetworkRun(
        id=9,
        dataset_id=3,
        relation="custom",
        params=params.model_dump(mode="json"),
        status="succeeded",
        result=network,
        node_count=len(network["nodes"]),
        edge_count=len(network["edges"]),
    )
    meta = network_metadata(run)
    text = json.dumps(meta, ensure_ascii=False)

    nodes, edges = network["nodes"], network["edges"]
    assert (meta["nodes"], meta["links"]) == (len(nodes), len(edges))
    teams = [n["team"] for n in nodes]
    named = sorted(
        (teams.count(t) for t in set(teams) if t not in (TEAM_OTHER, TEAM_UNKNOWN)), reverse=True
    )
    assert [g["nodes"] for g in meta["groups_by_rank"]] == named
    assert [g["rank"] for g in meta["groups_by_rank"]] == list(range(1, len(named) + 1))
    assert meta["relation_types"] == [{"name": "shares_keywords_with", "links": len(edges)}]
    weights = [e["weight"] for e in edges]
    assert meta["weight_range"] == {"min": min(weights), "max": max(weights)}
    node_attrs = {a["name"]: a for a in meta["node_attributes"]}
    assert "country" in node_attrs and all(
        isinstance(c, int) for c in node_attrs["country"]["top_value_counts"]
    )
    assert {a["name"] for a in meta["link_attributes"]} == {"evidence"}

    # No label, group name or attribute value.
    values = {n["name"] for n in nodes} | {n["id"] for n in nodes} | set(teams)
    for item in [*nodes, *edges]:
        values |= _strings(item.get("attr") or {})
    values -= {TEAM_OTHER, TEAM_UNKNOWN}
    assert {"Univ Parma", "Italy", "fetal ultrasound"} <= _data_values(values)
    assert [v for v in _data_values(values) if v in text] == []


def test_proposal_shares_are_rounded_to_whole_percents():
    # The Build form takes whole percents (1-100): the proposal holds what it shows.
    dataset = Dataset(id=7, name="x", profile_status="pending")
    p = check_proposal(dataset, _proposal(max_item_df=0.123))
    assert p.max_item_df == 0.12
    assert check_proposal(dataset, _proposal(max_item_df=0.125)).max_item_df == 0.13  # half up
    assert check_proposal(dataset, _proposal(max_item_df=0.001)).max_item_df == 0.01  # >= 1%
    assert check_proposal(dataset, _proposal(max_item_df=0.999)).max_item_df == 1
    p = check_proposal(
        dataset,
        _proposal(link="article_title", model="word_overlap", threshold=0.6666, max_word_df=0.004),
    )
    assert (p.threshold, p.max_word_df) == (0.67, 0.01)
    assert "similarity at least 67%" in p.summary
    # Out of range stays refused.
    for bad in (0, -0.2, 1.5):
        with pytest.raises(ToolFailed, match="max_item_df"):
            check_proposal(dataset, _proposal(max_item_df=bad))
    # The tool says so.
    propose = next(t for t in TOOLS if t["name"] == "propose_network")
    assert "nearest whole percent, at least 1%" in propose["description"]


def _ctx(db=None) -> ToolContext:
    return ToolContext(db=db, user_id=1, page="other", dataset_id=None, run_id=None)  # type: ignore[arg-type]


def test_unexpected_tool_error_is_a_generic_error_result(monkeypatch, caplog):
    def broken(ctx, args):
        raise ValueError("Univ Zyxq secret value")

    monkeypatch.setattr(tools, "get_network_options", broken)
    content, is_error = run_tool("get_network_options", {"dataset_id": 1}, _ctx(), Collected())
    assert is_error is True
    assert content == tools.TOOL_BROKE
    assert "Zyxq" not in content
    assert "ValueError" in caplog.text and "Zyxq" not in caplog.text


class _Runs:
    def __init__(self, runs: list[NetworkRun]):
        self.runs = runs

    def scalars(self, query):
        return iter(self.runs)


def test_list_runs_returns_the_count_of_node_attributes_not_their_names():
    params = CustomParams(node_attributes=("Zyxq Column", "country")).model_dump(mode="json")
    run = NetworkRun(id=4, dataset_id=2, relation="custom", params=params, status="succeeded")
    out = tools.list_runs(_ctx(_Runs([run])), tools.DatasetRef(dataset_id=None))
    listed = out["runs"][0]["params"]
    assert "node_attributes" not in listed
    assert listed["node_attribute_count"] == 2
    assert "Zyxq" not in json.dumps(out)


# ---------------------------------------------------------------- settings that applied (REQ-AST-6)

THRESHOLDS = {"min_shared", "max_item_df", "threshold", "max_word_df"}


def _stored_run(run_id: int, **params) -> NetworkRun:
    """A succeeded custom run whose stored settings hold every threshold, as runs store them."""
    stored = CustomParams(**params).model_dump(mode="json")
    assert THRESHOLDS <= set(stored) and "model" in stored
    return NetworkRun(
        id=run_id,
        dataset_id=2,
        relation="custom",
        params=stored,
        status="succeeded",
        result={"nodes": [], "edges": []},
        node_count=0,
        edge_count=0,
    )


def _listed_and_described(run: NetworkRun) -> list[dict]:
    listed = tools.list_runs(_ctx(_Runs([run])), tools.DatasetRef(dataset_id=None))
    return [listed["runs"][0]["params"], network_metadata(run)["params"]]


def test_same_article_network_settings_leave_out_the_unused_model_and_thresholds():
    run = _stored_run(
        4,
        entity="country",
        link="same_article",
        top_n=120,
        max_authors=30,
        min_weight=2,
        node_attributes=("Zyxq Column", "country"),
    )
    for params in _listed_and_described(run):
        assert "model" not in params
        assert not THRESHOLDS & set(params)
        assert params["entity"] == "country" and params["link"] == "same_article"
        assert (params["top_n"], params["max_authors"], params["min_weight"]) == (120, 30, 2)
        assert params["node_attribute_count"] == 2
        text = json.dumps(params)
        assert "word_matching" not in text and "Zyxq" not in text
    # What the model reads about the dataset's link fields: no model for Same article.
    meta = dataset_metadata(Dataset(id=2, name="x", profile_status="pending"))
    links = {lk["key"]: lk for lk in meta["links"]}
    assert links["same_article"]["models"] == []
    assert links["keywords"]["models"] == ["word_matching"]
    # The preset relations keep every setting.
    assert tools._params_metadata("institution_keywords", {"min_shared_keywords": 3}) == {
        "min_shared_keywords": 3
    }


def test_network_settings_list_only_the_thresholds_of_their_model():
    cases = [
        ({"link": "keywords", "model": "word_matching"}, {"min_shared", "max_item_df"}),
        ({"link": "article_title", "model": "word_overlap"}, {"threshold", "max_word_df"}),
        (
            {"link": "article_title", "model": "character_similarity"},
            {"threshold", "max_word_df"},
        ),
    ]
    for params, used in cases:
        run = _stored_run(6, entity="journal", **params)
        for listed in _listed_and_described(run):
            assert THRESHOLDS & set(listed) == used, params
            assert listed["model"] == params["model"]
            assert all(listed[k] == run.params[k] for k in used)


def _same_article_args(**overrides) -> dict:
    return {
        "entity": "author",
        "link": "same_article",
        "model": None,
        "top_n": 300,
        "min_weight": 2,
        "min_shared": 3,
        "max_item_df": 0.05,
        "threshold": None,
        "max_word_df": None,
    } | overrides


def test_same_article_proposal_result_names_no_model_or_thresholds(monkeypatch):
    dataset = Dataset(id=7, name="x", profile_status="pending")
    monkeypatch.setattr(tools, "_dataset", lambda ctx, dataset_id: dataset)
    for model in (None, "word_matching"):  # the guide says null; word_matching still fits
        out = Collected()
        content, is_error = run_tool(
            "propose_network", _same_article_args(model=model), _ctx(), out
        )
        assert is_error is False, content
        result = json.loads(content)
        assert "model" not in result["settings"]
        assert not THRESHOLDS & set(result["settings"])
        for word in ("word_matching", "Word matching", "word matching", "threshold"):
            assert word not in content
        # The proposal shown to the user: its summary has no model or thresholds.
        assert out.proposal is not None
        assert out.proposal.summary == (
            "Author linked by Same article (co-occurrence), links of weight 2 or more, "
            "up to 300 nodes"
        )
        assert (out.proposal.min_shared, out.proposal.max_item_df) == (None, None)
    # Any other link field still needs a model ...
    content, is_error = run_tool(
        "propose_network", _same_article_args(link="keywords"), _ctx(), Collected()
    )
    assert is_error is True and "needs a model" in content
    # ... and its result names the model and only that model's thresholds.
    content, is_error = run_tool(
        "propose_network",
        _same_article_args(link="keywords", model="word_matching"),
        _ctx(),
        Collected(),
    )
    settings = json.loads(content)["settings"]
    assert settings["model"] == "word_matching"
    assert THRESHOLDS & set(settings) == {"min_shared", "max_item_df"}


def test_platform_guide_gives_same_article_no_model_or_thresholds():
    line = next(ln for ln in SYSTEM_PROMPT.splitlines() if ln.startswith("- same_article: "))
    assert '"Same article (co-occurrence)"' in line
    assert "no model and no thresholds" in line
    assert "models:" not in line
    for model in custom.MODELS:
        assert model not in line
    assert "Same article (co-occurrence)\n  uses no model and no thresholds" in SYSTEM_PROMPT
    propose = next(t for t in TOOLS if t["name"] == "propose_network")
    assert "for same_article, model and every threshold are null" in propose["description"]
