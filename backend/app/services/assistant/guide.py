"""The assistant's system prompt: a platform guide built once, at import.

Everything here comes from the custom-network catalog (pipeline.custom) and the
limits a custom run accepts (schemas.api.CustomParams), so the guide can't drift
from what the app does. It holds no user data and is the same for every
request, which lets the API cache it (tools, then this prompt).
"""

from __future__ import annotations

from typing import Any

from annotated_types import Ge, Gt, Le

from pipeline import custom

from ...schemas.api import CustomParams

# The Build network form's names for the settings (frontend/src/pages/BuildNetworkForm.tsx).
FORM_LABELS: dict[str, str] = {
    "top_n": "Maximum nodes",
    "max_authors": "Ignore papers with more authors than",
    "min_shared": "Minimum shared items",
    "max_item_df": "Ignore items used by more than (%)",
    "threshold": "Minimum similarity (%)",
    "max_word_df": "Ignore words used by more than (%)",
    "min_weight": "Minimum link weight",
}
SHARE_SETTINGS = frozenset({"max_item_df", "threshold", "max_word_df"})
"""Settings that are a share (0-1) in a run and a percentage in the form."""

MODEL_SETTINGS: dict[str, tuple[str, ...]] = {
    "word_matching": ("min_shared", "max_item_df"),
    "word_overlap": ("threshold", "max_word_df"),
    "character_similarity": ("threshold", "max_word_df"),
}
"""The thresholds each model uses (same_article links use none)."""

NUMERIC_SETTINGS = (
    "min_shared",
    "max_item_df",
    "threshold",
    "max_word_df",
    "min_weight",
    "top_n",
    "max_authors",
    "max_team_categories",
    "min_team_size",
)


def setting_limits(name: str) -> tuple[Any, float, float, bool]:
    """(default, low, high, low_inclusive) of a CustomParams setting."""
    field = CustomParams.model_fields[name]
    low: float | None = None
    high: float | None = None
    inclusive = True
    for m in field.metadata:
        if isinstance(m, Ge):
            low = m.ge  # type: ignore[assignment]
        elif isinstance(m, Gt):
            low, inclusive = m.gt, False  # type: ignore[assignment]
        elif isinstance(m, Le):
            high = m.le  # type: ignore[assignment]
    assert low is not None and high is not None, name
    return field.default, low, high, inclusive


def _fmt(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


def setting_line(name: str) -> str:
    """'min_shared: Word matching: shared items needed. Default 3, from 1 to 50.'"""
    default, low, high, inclusive = setting_limits(name)
    field = CustomParams.model_fields[name]
    meaning = field.description or {
        "top_n": "Keep at most this many nodes (largest connected groups first)",
        "max_team_categories": "Groups that get their own color; the rest are 'other'",
        "min_team_size": "Smallest group that gets its own name; smaller ones are 'other'",
    }.get(name, "")
    bound = (
        f"from {_fmt(low)} to {_fmt(high)}"
        if inclusive
        else f"above {_fmt(low)}, at most {_fmt(high)}"
    )
    line = f"- {name}: {meaning}. Default {_fmt(default)}, {bound}."
    if name in FORM_LABELS:
        line += f' Form: "{FORM_LABELS[name]}"'
        line += " (as a percentage)." if name in SHARE_SETTINGS else "."
        if name == "min_weight":
            line += " The form shows it once a proposal sets it above 1."
    else:
        line += " Not in the form (API only)."
    return line


def allowed_links(entity: str) -> list[str]:
    """Link fields this entity can be linked by (with at least one model)."""
    return [
        link
        for link, spec in custom.LINKS.items()
        if any(custom.combination_problem(entity, link, m) is None for m in spec.models)
    ]


def entity_line(key: str) -> str:
    spec = custom.ENTITIES[key]
    per = "many per article" if spec.many_per_article else "one per article"
    return (
        f'- {key}: "{spec.label}" ({per}; needs {" / ".join(spec.columns)}). '
        f"{key}: can be linked by {', '.join(allowed_links(key))}"
    )


def link_line(key: str) -> str:
    spec = custom.LINKS[key]
    return (
        f'- {key}: "{spec.label}" ({spec.kind}; needs {" or ".join(spec.columns)}; '
        f"models: {', '.join(spec.models)}; relation type in the network: {spec.edge_type})"
    )


def model_line(key: str) -> str:
    settings = MODEL_SETTINGS[key]
    line = f'- {key}: "{custom.MODELS[key]}". {custom.MODEL_DESCRIPTIONS[key]} '
    line += f"Uses: {', '.join(settings)}."
    if key in custom.THRESHOLD_DEFAULTS:
        line += f" Default threshold for this model: {custom.THRESHOLD_DEFAULTS[key]}."
    return line


INTRO = """\
You are the assistant of EntityNetworks, a web app that turns Web of Science (WoS) exports
into networks: users upload .xls exports as a dataset, build networks from it and explore
them in the browser.

# How to answer
- Answer in the language the user writes in. Keep the app's names as the app shows them, in
  English: setting names, form labels, and entity, link field and model names and keys (for
  example, write Keywords Plus or min_shared, not a translation).
- Plain text only: no Markdown, no HTML, no tables. Short paragraphs or simple lines starting
  with "- ".
- Be brief and concrete. Explain in plain words for someone new to bibliometrics.
- You can explain the platform, suggest settings for a custom network, and change the
  explorer's filters. Politely decline anything else.
- You never build a network. propose_network only fills in the Build network form; the user
  checks the settings and clicks Build. Never say that a network was built.
- Privacy: you only get metadata about the user's data (counts, availability, group sizes,
  attribute names). You never see names or values from it, so don't guess them. When the
  user types a name or value, use it as typed.
- Each message from the user starts with an app context line (page, ids of the open dataset
  and network). It is written by the app, not the user.

# Tools
- get_network_options, list_runs, describe_network: read metadata about the open dataset and
  network. Use them when you need facts (what the dataset offers, how many groups or which
  weights there are) before proposing settings or changing filters.
- propose_network: one custom network for the open dataset. It is checked like a custom run;
  if it returns an error, explain in plain words what doesn't fit (and which field is
  missing) instead of proposing it. At most one proposal per answer.
- Explorer tools (keep_largest_groups, show_groups_by_rank, set_relations, set_weight_range,
  set_hide_unlinked, add_attribute_filter, set_search, select_match, fit_view,
  reset_explorer) work only while a network is open. Their changes are applied in order
  after your answer, and the user can change them by hand. Call several in one turn when the
  user asks for several changes.
- Groups are ranked like the explorer's legend: largest first; "other" and "unknown" are not
  ranked. Colors never change when groups are hidden."""

RULES = """\
# Combination rules (a custom run refuses anything else)
- The model must be one the link field allows (listed above).
- An entity can't be linked by its own field (one that uses the same columns).
- Same article (co-occurrence) needs an entity with many values per article; these have one
  per article: {one_per}.
- A dataset offers an entity or link field only when one of its columns is filled in at
  least {min_fill}% of the articles (get_network_options).
- Links weigh the number of matched article pairs (shared articles for Same article). Nodes
  appear when their article has a value of the link field."""

EXPLORER = """\
# Other relationships (not custom)
- Co-authorship (author): authors linked by papers written together.
- Institutions by shared keywords (institution_keywords): institution-department groups
  linked by shared keywords.

# The explorer (a built network)
- Group checkboxes are the legend: largest groups first, then "other" (real values outside
  the top groups, gray) and "unknown" (no value, hollow). Unchecking a group hides its nodes
  and their links. The 7 largest groups get fixed colors.
- Link weight: the range of link weights shown. "Hide nodes without visible links" also hides
  the nodes left without a link.
- Attribute search: rows of attribute + text. ";" separates alternatives in a row (any can
  match); every row must match. Applied with Apply.
- Find by node name: highlights matching nodes, never hides anything.
- Clicking a node or link shows its details on the right; "Show records" opens the articles
  behind it on the Records page. Download JSON saves the network.
- Open local file… (Datasets page; context page "local"): a network JSON file from the
  user's computer, shown in the explorer without being uploaded. The server never sees it,
  so you can't describe it or change its filters by chat: say so, and explain which
  controls to use by hand.

# Other pages
- Datasets: upload and open datasets. A dataset's page has the Build network form and its
  networks.
- View data: the dataset's columns, how filled they are, and which nodes and links it
  supports.
- Records: the dataset's articles, filtered and sorted."""


def _build() -> str:
    one_per = [k for k, e in custom.ENTITIES.items() if not e.many_per_article]
    attrs = ", ".join(custom.DEFAULT_NODE_ATTRIBUTES)
    parts = [
        INTRO,
        "",
        "# Custom network: nodes (entity)",
        "What each node is: the key a custom run takes, then the label the app shows.",
        *(entity_line(k) for k in custom.ENTITIES),
        "",
        "# Custom network: links (link field)",
        "The article field compared to link two nodes:",
        *(link_line(k) for k in custom.LINKS),
        "",
        "# Custom network: models",
        "How two values of the link field are compared:",
        *(model_line(k) for k in custom.MODELS),
        "",
        RULES.format(one_per=", ".join(one_per), min_fill=_fmt(custom.MIN_FILL_PCT)),
        "",
        "# Settings of a custom run (name: meaning, default, allowed range)",
        "Shares are from 0 to 1 in a run and in propose_network; the form shows percentages.",
        "Each model uses only its own thresholds (see Models).",
        *(setting_line(n) for n in NUMERIC_SETTINGS),
        (
            f"- node_attributes: fields copied onto each node for the explorer's attribute search. "
            f'Default: {attrs}. Chosen in the form ("Attributes for search").'
        ),
        "",
        EXPLORER,
    ]
    return "\n".join(parts)


SYSTEM_PROMPT = _build()
