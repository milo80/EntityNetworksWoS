import copy
import json

import pytest
from pydantic import ValidationError

from pipeline.schema import (
    SCHEMA_PATH,
    TEAM_OTHER,
    TEAM_UNKNOWN,
    network_to_dict,
    render_json_schema,
    validate_network,
)

from .conftest import GOLDEN_DIR

GOLDENS = sorted(GOLDEN_DIR.glob("*.json"))

VALID = {
    "nodes": [
        {"id": "0000-0001-2345-6789", "name": "Doe, Ann", "team": "Italy", "role": "1 co-authors",
         "attr": {"institution": "Univ Parma", "author_keywords": ["ai", "ethics"]}},
        {"id": "LOCAL-abc123def456", "name": "Roe, Bob", "team": TEAM_UNKNOWN,
         "role": "1 co-authors"},
    ],
    "edges": [
        {"source": "0000-0001-2345-6789", "target": "LOCAL-abc123def456",
         "type": "collaborates_with", "weight": 2, "attr": {"article_titles": ["T1", "T2"]}},
    ],
}


@pytest.mark.parametrize("path", GOLDENS, ids=lambda p: p.name)
def test_goldens_conform_and_round_trip(path):
    raw = path.read_bytes()
    network = validate_network(raw)
    assert network_to_dict(network) == json.loads(raw)


def test_goldens_use_reserved_team_values_only_as_documented():
    for path in GOLDENS:
        teams = {n["team"] for n in json.loads(path.read_text())["nodes"]}
        assert teams  # sanity
        assert not {t.lower() for t in teams} & {"none", "null", "nan", ""}


def test_valid_example_round_trips():
    assert network_to_dict(validate_network(VALID)) == VALID


def _mutated(fn):
    data = copy.deepcopy(VALID)
    fn(data)
    return data


@pytest.mark.parametrize("mutate, message", [
    (lambda d: d["nodes"].append(dict(d["nodes"][0])), "duplicate node id"),
    (lambda d: d["edges"][0].update(target="missing"), "unknown node"),
    (lambda d: d["edges"][0].update(target=d["edges"][0]["source"]), "self-loop"),
    (lambda d: d["edges"].append({**d["edges"][0], "source": d["edges"][0]["target"],
                                  "target": d["edges"][0]["source"]}), "duplicate collaborates_with"),
    (lambda d: d["edges"][0].update(weight=0), "greater than or equal to 1"),
    (lambda d: d["edges"][0].update(weight="2"), "valid integer"),
    (lambda d: d["nodes"][0].update(id=123), "valid string"),
    (lambda d: d["nodes"][0].update(color="red"), "Extra inputs are not permitted"),
    (lambda d: d["nodes"][0].pop("team"), "Field required"),
    (lambda d: d["nodes"][0].update(team=""), "at least 1 character"),
    (lambda d: d["nodes"][0]["attr"].update(city=None), "attr.city"),
    (lambda d: d["nodes"][0]["attr"].update(author_keywords=["ok", 3]), "author_keywords"),
])
def test_invalid_networks_rejected(mutate, message):
    with pytest.raises(ValidationError, match=message):
        validate_network(_mutated(mutate))


def test_other_and_unknown_are_distinct():
    assert TEAM_OTHER != TEAM_UNKNOWN


def test_committed_json_schema_is_up_to_date():
    assert SCHEMA_PATH.exists(), "run: python -m pipeline.schema"
    assert SCHEMA_PATH.read_text(encoding="utf-8") == render_json_schema(), \
        "docs/network.schema.json is stale - run: python -m pipeline.schema"
