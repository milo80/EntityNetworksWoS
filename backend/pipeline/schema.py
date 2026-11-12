"""The network JSON contract shared by the pipeline, the API and the frontend.

    {"nodes": [{"id", "name", "team", "role", "attr"?}],
     "edges": [{"source", "target", "type", "weight", "attr"?}]}

This module is the single source of truth. The JSON Schema in
docs/network.schema.json is generated from it (``python -m pipeline.schema``)
and is what the frontend types are built from - don't edit that file by hand.

Validation is strict (no type coercion, no unknown fields) so that any drift
between what the pipeline produces and what the frontend expects fails loudly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

TEAM_OTHER = "other"
"""A real value exists but didn't make the top-N categories."""
TEAM_UNKNOWN = "unknown"
"""No value at all. Kept distinct from TEAM_OTHER on purpose."""

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "docs" / "network.schema.json"

NonEmptyStr = Annotated[str, Field(min_length=1)]
AttrValue = str | int | float | list[str]
Attr = Annotated[
    dict[str, AttrValue],
    Field(description="Display/search-only attributes. Never drives color or the "
                      "Group/Relationship filters. Empty values are omitted."),
]


class _Strict(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


class NetworkNode(_Strict):
    id: NonEmptyStr = Field(description="ORCID, LOCAL-<hash>, or an institution/country name. "
                                        "Never a raw author name.")
    name: str = Field(description="Human-readable display name.")
    team: NonEmptyStr = Field(description="Drives node color and the Group filter. "
                                          f"'{TEAM_OTHER}' = real value outside the top-N; "
                                          f"'{TEAM_UNKNOWN}' = no value.")
    role: str = Field(description="Short description, e.g. '14 co-authors'.")
    attr: Attr | None = None


class NetworkEdge(_Strict):
    source: NonEmptyStr
    target: NonEmptyStr
    type: NonEmptyStr = Field(description="Relationship, e.g. collaborates_with, "
                                          "shares_keywords_with. Drives the Relationship filter.")
    weight: int = Field(ge=1, description="Strength, e.g. number of shared articles.")
    attr: Attr | None = None


class Network(_Strict):
    nodes: list[NetworkNode]
    edges: list[NetworkEdge]

    @model_validator(mode="after")
    def _check_graph(self) -> Network:
        ids: set[str] = set()
        for n in self.nodes:
            if n.id in ids:
                raise ValueError(f"duplicate node id {n.id!r}")
            ids.add(n.id)

        pairs: set[tuple[str, str, str]] = set()
        for e in self.edges:
            for end in (e.source, e.target):
                if end not in ids:
                    raise ValueError(f"edge {e.source!r} -> {e.target!r} references unknown "
                                     f"node {end!r}")
            if e.source == e.target:
                raise ValueError(f"self-loop on node {e.source!r}")
            key = (*sorted((e.source, e.target)), e.type)
            if key in pairs:
                raise ValueError(f"duplicate {e.type} edge between {e.source!r} and {e.target!r}")
            pairs.add(key)
        return self


def validate_network(data: Any) -> Network:
    """Validate a network dict (or JSON string/bytes) against the contract."""
    if isinstance(data, (str, bytes)):
        return Network.model_validate_json(data)
    return Network.model_validate(data)


def network_to_dict(network: Network) -> dict:
    """Serialize back to the on-the-wire shape (omitted 'attr' stays omitted)."""
    return network.model_dump(exclude_none=True)


def json_schema() -> dict:
    schema = Network.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["title"] = "EntityNetworks network"
    return schema


def render_json_schema() -> str:
    return json.dumps(json_schema(), indent=2) + "\n"


if __name__ == "__main__":
    SCHEMA_PATH.write_text(render_json_schema(), encoding="utf-8")
    print(f"Wrote {SCHEMA_PATH}", file=sys.stderr)
