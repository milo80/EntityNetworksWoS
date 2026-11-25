"""The assistant's tools: what the model may read and what it may ask the UI to do.

Read tools return metadata only: availability, counts, group sizes by rank,
relation type names, weights and attribute names with value counts. They never
return a node label, group name, attribute or record value, or a dataset or
file name. Every lookup is scoped to the user, and another user's id gets the
same "not found" as an id that doesn't exist.

UI tools (propose_network, the explorer actions) change nothing on the server:
their validated input is collected and returned to the browser with the reply.
"""

from __future__ import annotations

import json
import logging
import math
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, cast

from anthropic import transform_schema
from anthropic.types import ToolParam
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from pipeline import custom

from ...api.datasets import get_owned_dataset, network_options
from ...api.runs import get_owned_run
from ...models import Dataset, NetworkRun
from ...schemas.api import CustomParams, EntityName, LinkName, ModelName
from ...schemas.assistant import (
    AddAttributeFilter,
    ExplorerAction,
    Fit,
    GroupsByRank,
    KeepLargestGroups,
    NetworkProposal,
    Reset,
    SelectMatch,
    SetHideUnlinked,
    SetRelations,
    SetSearch,
    SetWeightRange,
)
from ...schemas.network import TEAM_OTHER, TEAM_UNKNOWN
from .guide import MODEL_SETTINGS

log = logging.getLogger(__name__)

MAX_RUNS_LISTED = 50
MAX_WEIGHTS_LISTED = 40
MAX_VALUE_COUNTS = 10

NOT_FOUND_DATASET = "Dataset not found."
NOT_FOUND_RUN = "Network not found."
NO_DATASET = "No dataset is open. Ask the user to open one of their datasets first."
NO_NETWORK = "No network is open in the explorer, so the explorer can't be changed."
TOOL_BROKE = "This tool failed unexpectedly. Answer without it."

SHARE_FIELDS = ("max_item_df", "threshold", "max_word_df")
"""Settings given as a share (0-1); the Build form takes them as whole percents."""


class ToolFailed(Exception):
    """A tool can't answer; the message goes back to the model as an error result."""


@dataclass
class ToolContext:
    db: Session
    user_id: int
    page: str
    dataset_id: int | None
    run_id: int | None


@dataclass
class Collected:
    """What the UI tools asked for during one answer."""

    proposal: NetworkProposal | None = None
    actions: list[ExplorerAction] = field(default_factory=list)


# ---------------------------------------------------------------- lookups (user-scoped)


def _dataset(ctx: ToolContext, dataset_id: int | None) -> Dataset:
    wanted = dataset_id if dataset_id is not None else open_dataset_id(ctx)
    if wanted is None:
        raise ToolFailed(NO_DATASET)
    try:
        return get_owned_dataset(ctx.db, ctx.user_id, wanted)
    except HTTPException:
        raise ToolFailed(NOT_FOUND_DATASET) from None


def _run(ctx: ToolContext, run_id: int | None) -> NetworkRun:
    wanted = run_id if run_id is not None else ctx.run_id
    if wanted is None:
        raise ToolFailed("No network is open. Ask the user to open one, or give its id.")
    try:
        return get_owned_run(ctx.db, ctx.user_id, wanted)
    except HTTPException:
        raise ToolFailed(NOT_FOUND_RUN) from None


def open_dataset_id(ctx: ToolContext) -> int | None:
    """The open dataset: the one in the context, else the open network's."""
    if ctx.dataset_id is not None:
        return ctx.dataset_id
    if ctx.run_id is not None:
        run = ctx.db.scalar(
            select(NetworkRun).where(
                NetworkRun.id == ctx.run_id, NetworkRun.owner_id == ctx.user_id
            )
        )
        return run.dataset_id if run else None
    return None


def open_network(ctx: ToolContext) -> NetworkRun | None:
    """The network open in the explorer, if it is the user's and finished."""
    if ctx.run_id is None:
        return None
    run = ctx.db.scalar(
        select(NetworkRun).where(NetworkRun.id == ctx.run_id, NetworkRun.owner_id == ctx.user_id)
    )
    return run if run is not None and run.status == "succeeded" else None


# ---------------------------------------------------------------- read tools


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DatasetRef(_Input):
    dataset_id: int | None = Field(description="A dataset id; null for the open dataset")


class RunRef(_Input):
    run_id: int | None = Field(description="A network (run) id; null for the open network")


def get_network_options(ctx: ToolContext, args: DatasetRef) -> dict[str, Any]:
    return dataset_metadata(_dataset(ctx, args.dataset_id))


def dataset_metadata(dataset: Dataset) -> dict[str, Any]:
    """What the dataset offers a custom network, and its article count. No names or values."""
    options = network_options(dataset)
    profile = dataset.profile if dataset.profile_status == "ready" else None
    articles = (profile or {}).get("stats", {}).get("articles")
    return {
        "dataset_id": dataset.id,
        "profile_status": dataset.profile_status,
        "articles": articles,
        "entities": [
            {
                "key": e.key,
                "available": e.available,
                "reason": e.reason,
                "links": e.links,
            }
            for e in options.entities
        ],
        "links": [
            {"key": lk.key, "available": lk.available, "reason": lk.reason, "models": lk.models}
            for lk in options.links
        ],
        "attributes": [
            {"key": a.key, "fill_pct": a.fill_pct, "not_for": a.not_for} for a in options.attributes
        ],
        "note": "Availability comes from how filled the columns are"
        + ("" if profile else "; the profile isn't ready, so everything is offered")
        + ".",
    }


def list_runs(ctx: ToolContext, args: DatasetRef) -> dict[str, Any]:
    query = select(NetworkRun).where(NetworkRun.owner_id == ctx.user_id)
    dataset_id = args.dataset_id if args.dataset_id is not None else open_dataset_id(ctx)
    if dataset_id is not None:
        query = query.where(NetworkRun.dataset_id == _dataset(ctx, dataset_id).id)
    runs = ctx.db.scalars(query.order_by(NetworkRun.id.desc()).limit(MAX_RUNS_LISTED))
    return {
        "dataset_id": dataset_id,
        "runs": [
            {
                "run_id": r.id,
                "dataset_id": r.dataset_id,
                "relation": r.relation,
                "status": r.status,
                "params": _params_metadata(r.params),
                "nodes": r.node_count,
                "links": r.edge_count,
            }
            for r in runs
        ],
    }


def _params_metadata(params: dict[str, Any]) -> dict[str, Any]:
    """A run's settings, with the count of its node attribute fields instead of their names."""
    out = {k: v for k, v in params.items() if k != "node_attributes"}
    if "node_attributes" in params:
        out["node_attribute_count"] = len(params["node_attributes"] or [])
    return out


def _value_counts(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per attribute: how many items have it, how many distinct values, top counts."""
    counts: dict[str, Counter[str]] = {}
    with_value: Counter[str] = Counter()
    for item in items:
        for key, value in (item.get("attr") or {}).items():
            with_value[key] += 1
            values = value if isinstance(value, list) else [value]
            counts.setdefault(key, Counter()).update(str(v) for v in values)
    return [
        {
            "name": key,
            "with_value": with_value[key],
            "distinct_values": len(c),
            "top_value_counts": [n for _, n in c.most_common(MAX_VALUE_COUNTS)],
        }
        for key, c in sorted(counts.items())
    ]


def describe_network(ctx: ToolContext, args: RunRef) -> dict[str, Any]:
    return network_metadata(_run(ctx, args.run_id))


def network_metadata(run: NetworkRun) -> dict[str, Any]:
    """Counts, group sizes by rank, relation types, weights, attribute names. No values."""
    if run.status != "succeeded":
        return {"run_id": run.id, "status": run.status, "note": "No network until it succeeds."}
    network = run.result or {"nodes": [], "edges": []}
    nodes: list[dict[str, Any]] = network.get("nodes", [])
    edges: list[dict[str, Any]] = network.get("edges", [])
    teams = Counter(n["team"] for n in nodes)
    ranked = sorted(
        (c for t, c in teams.items() if t not in (TEAM_OTHER, TEAM_UNKNOWN)), reverse=True
    )
    weights = Counter(int(e.get("weight", 1)) for e in edges)
    linked = {e["source"] for e in edges} | {e["target"] for e in edges}
    weight_list = sorted(weights.items())
    return {
        "run_id": run.id,
        "dataset_id": run.dataset_id,
        "relation": run.relation,
        "params": _params_metadata(run.params),
        "nodes": len(nodes),
        "links": len(edges),
        "groups_by_rank": [{"rank": i + 1, "nodes": c} for i, c in enumerate(ranked)],
        "other_nodes": teams.get(TEAM_OTHER, 0),
        "unknown_nodes": teams.get(TEAM_UNKNOWN, 0),
        "relation_types": [
            {"name": t, "links": c} for t, c in Counter(e["type"] for e in edges).items()
        ],
        "weight_range": {"min": weight_list[0][0], "max": weight_list[-1][0]}
        if weight_list
        else None,
        "links_by_weight": [{"weight": w, "links": c} for w, c in weight_list[:MAX_WEIGHTS_LISTED]],
        "unlinked_nodes": sum(1 for n in nodes if n["id"] not in linked),
        "node_attributes": _value_counts(nodes),
        "link_attributes": _value_counts(edges),
    }


# ---------------------------------------------------------------- propose_network


class ProposeNetworkInput(_Input):
    entity: EntityName
    link: LinkName
    model: ModelName
    top_n: int = Field(description="Maximum nodes")
    min_weight: int = Field(description="Minimum link weight (1 keeps every link)")
    min_shared: int | None = Field(description="word_matching only, else null")
    max_item_df: float | None = Field(description="word_matching only (a share, 0-1), else null")
    threshold: float | None = Field(description="string models only (0-1), else null")
    max_word_df: float | None = Field(description="string models only (a share, 0-1), else null")


def _pct(share: float) -> str:
    return f"{round(share * 100)}%"


def summary(p: NetworkProposal) -> str:
    """'Institution (all authors) linked by Keywords (...), word matching, at least 3 shared'."""
    text = f"{custom.ENTITIES[p.entity].label} linked by {custom.LINKS[p.link].label}"
    co_occurrence = custom.LINKS[p.link].kind == "same_article"  # no thresholds
    if not co_occurrence and p.model == "word_matching":
        text += f", word matching, at least {p.min_shared} shared"
    elif not co_occurrence:
        text += f", {custom.MODELS[p.model].lower()}, similarity at least {_pct(p.threshold or 0)}"
    if p.min_weight > 1:
        text += f", links of weight {p.min_weight} or more"
    return text + f", up to {p.top_n} nodes"


def _validation_message(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = ".".join(str(x) for x in err["loc"])
        msg = str(err["msg"]).removeprefix("Value error, ")
        parts.append(f"{loc}: {msg}" if loc else msg)
    return "; ".join(parts)


def propose_network(ctx: ToolContext, args: ProposeNetworkInput, out: Collected) -> dict[str, Any]:
    proposal = check_proposal(_dataset(ctx, None), args)
    out.proposal = proposal
    return {
        "proposed": True,
        "note": "The user's Build network form will be filled in with these settings. "
        "Nothing is built until the user clicks Build.",
        "settings": proposal.model_dump(exclude={"summary"}),
    }


def whole_percent(share: float) -> float:
    """A share rounded like the Build form shows it: nearest whole percent, at least 1%.

    Half rounds up (JavaScript's Math.round). Shares at or below 0 are left for the
    range check to refuse.
    """
    if share <= 0:
        return share
    return max(1, math.floor(share * 100 + 0.5)) / 100


def check_proposal(dataset: Dataset, args: ProposeNetworkInput) -> NetworkProposal:
    """The proposal if a custom run on this dataset would accept it; ToolFailed otherwise.

    Shares are rounded to whole percents first, so the proposal is what the form shows.
    """
    uses = (
        () if custom.LINKS[args.link].kind == "same_article" else MODEL_SETTINGS.get(args.model, ())
    )
    given = {k: getattr(args, k) for k in uses if getattr(args, k) is not None}
    if args.model in custom.THRESHOLD_DEFAULTS and "threshold" in uses:
        given.setdefault("threshold", custom.THRESHOLD_DEFAULTS[args.model])
    for k in SHARE_FIELDS:
        if k in given:
            given[k] = whole_percent(given[k])
    try:
        params = CustomParams(
            entity=args.entity,
            link=args.link,
            model=args.model,
            top_n=args.top_n,
            min_weight=args.min_weight,
            **given,
        )
    except ValidationError as exc:
        raise ToolFailed(
            f"A custom run would refuse this: {_validation_message(exc)}. Not proposed."
        ) from None

    options = network_options(dataset)
    entity = next(e for e in options.entities if e.key == params.entity)
    link = next(lk for lk in options.links if lk.key == params.link)
    missing = [
        f"{label} ({key}): {reason}"
        for key, label, ok, reason in (
            (entity.key, entity.label, entity.available, entity.reason),
            (link.key, link.label, link.available, link.reason),
        )
        if not ok
    ]
    if missing:
        raise ToolFailed(
            f"This dataset doesn't offer what the proposal needs: {'; '.join(missing)}. "
            "Not proposed."
        )

    proposal = NetworkProposal(
        dataset_id=dataset.id,
        entity=params.entity,
        link=params.link,
        model=params.model,
        top_n=params.top_n,
        min_weight=params.min_weight,
        min_shared=params.min_shared if "min_shared" in uses else None,
        max_item_df=params.max_item_df if "max_item_df" in uses else None,
        threshold=params.threshold if "threshold" in uses else None,
        max_word_df=params.max_word_df if "max_word_df" in uses else None,
        summary="",
    )
    proposal.summary = summary(proposal)
    return proposal


# ---------------------------------------------------------------- tool table

ACTION_TOOLS: dict[str, tuple[type[BaseModel], str]] = {
    "keep_largest_groups": (KeepLargestGroups, "keep_largest_groups"),
    "show_groups_by_rank": (GroupsByRank, "groups_by_rank"),
    "set_relations": (SetRelations, "set_relations"),
    "set_weight_range": (SetWeightRange, "set_weight_range"),
    "set_hide_unlinked": (SetHideUnlinked, "set_hide_unlinked"),
    "add_attribute_filter": (AddAttributeFilter, "add_attribute_filter"),
    "set_search": (SetSearch, "set_search"),
    "select_match": (SelectMatch, "select_match"),
    "fit_view": (Fit, "fit"),
    "reset_explorer": (Reset, "reset"),
}
"""Tool name -> (action model, its kind)."""
ACTION_HINTS: dict[str, str] = {
    "keep_largest_groups": " Use it for 'only the N largest groups'.",
    "show_groups_by_rank": " Use it for 'groups 2 and 3'.",
    "set_relations": " Names are the network's relation types (describe_network).",
    "set_weight_range": " Bounds outside the network's weights are clamped. "
    "For 'the strongest links', raise min.",
    "add_attribute_filter": " Values are the terms the user typed (any can match); "
    "attribute is one of the network's attribute names (describe_network).",
    "set_search": " Highlights nodes whose name contains the text; hides nothing.",
    "select_match": " Run set_search first. Selects the n-th highlighted node and shows "
    "its details.",
    "reset_explorer": " Every group and relation checked, full weight range, no attribute "
    "rows, empty search.",
}


def _action_schema(model: type[BaseModel]) -> dict[str, Any]:
    schema = model.model_json_schema()
    schema["properties"].pop("kind", None)
    schema["required"] = [r for r in schema.get("required", []) if r != "kind"]
    schema.pop("title", None)
    schema.pop("description", None)
    return transform_schema(schema)


def _input_schema(model: type[BaseModel]) -> dict[str, Any]:
    schema = model.model_json_schema()
    schema.pop("title", None)
    return transform_schema(schema)


READ_TOOLS: dict[str, tuple[type[_Input], str]] = {
    "get_network_options": (
        DatasetRef,
        (
            "What a custom network can be built from in a dataset: the entities, link fields "
            "and models it offers (with why not), the article count and the fields available "
            "as node attributes with how filled they are. Metadata only."
        ),
    ),
    "list_runs": (
        DatasetRef,
        (
            "The user's networks (runs) of a dataset: relation, status, settings and node and "
            "link counts. With null and no open dataset: all of the user's networks."
        ),
    ),
    "describe_network": (
        RunRef,
        (
            "Metadata of a built network: node and link counts, group sizes by legend rank, "
            "relation type names, link weights, unlinked nodes, and node and link attribute "
            "names with value counts (never the values)."
        ),
    ),
}


def _tools() -> list[ToolParam]:
    tools: list[ToolParam] = [
        {
            "name": name,
            "description": description,
            "input_schema": _input_schema(model),
            "strict": True,
        }
        for name, (model, description) in READ_TOOLS.items()
    ]
    tools.append(
        {
            "name": "propose_network",
            "description": "Propose one custom network for the open dataset. It is checked "
            "like a custom run (combination and ranges) and against what the dataset offers; "
            "an error says what doesn't fit. On success the user's Build network form is "
            "filled in; nothing is built. Give the thresholds of the chosen model and null "
            "for the others. Shares (max_item_df, threshold, max_word_df) are rounded to "
            "the nearest whole percent, at least 1% (0.123 becomes 0.12), as the form takes "
            "whole percents; the result has the rounded values.",
            "input_schema": _input_schema(ProposeNetworkInput),
            "strict": True,
        }
    )
    for name, (model, _) in ACTION_TOOLS.items():
        tools.append(
            {
                "name": name,
                "description": f"Explorer: {(model.__doc__ or '').strip()}"
                f"{ACTION_HINTS.get(name, '')} Only while a network is open.",
                "input_schema": _action_schema(model),
                "strict": True,
            }
        )
    return tools


TOOLS: list[ToolParam] = _tools()


def run_tool(name: str, raw: object, ctx: ToolContext, out: Collected) -> tuple[str, bool]:
    """Run one tool call: (content for the tool_result, is_error)."""
    result: dict[str, Any]
    try:
        if not isinstance(raw, dict):
            raise ToolFailed("The input must be an object.")
        if name == "get_network_options":
            result = get_network_options(ctx, DatasetRef.model_validate(raw))
        elif name == "list_runs":
            result = list_runs(ctx, DatasetRef.model_validate(raw))
        elif name == "describe_network":
            result = describe_network(ctx, RunRef.model_validate(raw))
        elif name == "propose_network":
            result = propose_network(ctx, ProposeNetworkInput.model_validate(raw), out)
        elif name in ACTION_TOOLS:
            action_type, kind = ACTION_TOOLS[name]
            action = action_type.model_validate({**raw, "kind": kind})
            if open_network(ctx) is None:
                raise ToolFailed(NO_NETWORK)
            out.actions.append(cast(ExplorerAction, action))
            result = {"queued": True, "note": "Applied in the explorer after your answer."}
        else:
            raise ToolFailed(f"Unknown tool {name!r}.")
    except ToolFailed as exc:
        return str(exc), True
    except ValidationError as exc:
        return f"Invalid input: {_validation_message(exc)}", True
    except Exception as exc:  # noqa: BLE001 - a bug must not end the answer; log no values
        log.error("Assistant: a tool failed (%s)", type(exc).__name__)
        return TOOL_BROKE, True
    return json.dumps(result, ensure_ascii=False, separators=(",", ":")), False
