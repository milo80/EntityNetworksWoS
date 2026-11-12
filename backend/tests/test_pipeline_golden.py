"""Golden snapshot tests: the pipeline must reproduce the reference networks exactly.

The goldens were produced by the legacy script with only two determinism fixes
(sorted input files, deterministic sampling order). If a change is intended to
alter output, review the difference first and then regenerate:

    python -m pipeline.cli ../data/wos -o /tmp/new
    python scripts/compare_networks.py tests/fixtures/golden/network_author.json /tmp/new/network_author.json
    python -m pipeline.cli ../data/wos -o tests/fixtures/golden
"""

import json

import pytest

from pipeline.relations import author_network, institution_keyword_network

from .conftest import GOLDEN_DIR


def _load(name):
    return json.loads((GOLDEN_DIR / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("build, golden", [
    (author_network, "network_author.json"),
    (institution_keyword_network, "network_institution_keywords.json"),
])
def test_matches_golden(articles, build, golden):
    # Round-trip through JSON so types match what's on disk (tuples -> lists etc.)
    result = json.loads(json.dumps(build(articles), ensure_ascii=False))
    expected = _load(golden)
    assert len(result["nodes"]) == len(expected["nodes"])
    assert len(result["edges"]) == len(expected["edges"])
    assert result == expected
