"""Custom networks: choose the nodes (an entity), the links (a field) and a model.

Every network here is built the same way:

1. each article is assigned its entities (its authors, its journal, ...);
2. a model finds the pairs of articles that match on the link field;
3. two entities are linked once per matched article pair in which they appear
   on opposite sides (never an entity with itself). Edge weight = number of
   matched article pairs.

"Same article" is the special link where each article matches itself, which
gives co-occurrence networks (co-authorship is Author x Same article).

The catalog is curated for WoS exports: entities and link fields name the
columns they need and parse them like the rest of the pipeline. Which of them
a dataset supports is decided from its profile (``availability``).
"""

from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from difflib import SequenceMatcher
from itertools import combinations
from typing import Any, Literal

import networkx as nx
import pandas as pd

from .authors import extract_authors_with_metadata, resolve_author_ids
from .export import graph_to_network
from .institutions import (
    ARTICLE_ID,
    enrich_with_institution_data,
    parse_address_block,
    parse_reprint_address_block,
    pick_anchor_institution,
)
from .keywords import normalize_keyword
from .schema import validate_network

log = logging.getLogger(__name__)

Model = Literal["word_matching", "word_overlap", "character_similarity"]
MODELS: dict[str, str] = {
    "word_matching": "Word matching",
    "word_overlap": "String similarity: word overlap",
    "character_similarity": "String similarity: characters",
}

MODEL_DESCRIPTIONS: dict[str, str] = {
    "word_matching": "Links when two articles share at least N items of a list field "
    "(e.g. keywords). Items used by too many articles are ignored.",
    "word_overlap": "Links when two texts share enough words: shared words / all words "
    "(Jaccard), common words ignored.",
    "character_similarity": "Links when two texts are spelled alike (difflib ratio): catches "
    "variants and typos in short fields like titles and names.",
}
THRESHOLD_DEFAULTS: dict[str, float] = {"word_overlap": 0.5, "character_similarity": 0.9}
"""Default 'threshold' per string model."""

MAX_ARTICLE_PAIRS = 2_000_000
"""More matched article pairs than this fails the run instead of exhausting memory."""
MAX_CANDIDATE_PAIRS = 5_000_000
"""Value pairs a string model may score."""
MIN_FILL_PCT = 20.0
"""A column filled in fewer articles than this is not offered."""
MAX_EVIDENCE_ITEMS = 20
MAX_EVIDENCE_PAIRS = 5


class NetworkBuildError(RuntimeError):
    """The chosen options can't build a network; the message is shown to the user."""


# An entity occurrence in one article: (id, display name, attributes).
Occurrence = tuple[str, str, dict[str, Any]]


# ------------------------------------------------------------------ helpers


def _split(value: Any) -> list[str]:
    """'a; b;; c' -> ['a', 'b', 'c'] (empty and missing -> [])."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return []
    return [part.strip() for part in str(value).split(";") if part.strip()]


def _dedupe(items: Iterable[str]) -> list[str]:
    """Case-insensitive dedupe, first spelling wins, order kept."""
    seen: dict[str, str] = {}
    for item in items:
        seen.setdefault(item.lower(), item)
    return list(seen.values())


def _text(value: Any) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    return str(value).strip()


_GRANT = re.compile(r"\s*\[[^\]]*\]\s*")


def _funders(value: Any) -> list[str]:
    """Funding Orgs: 'NIH [R01 123]; NSF' -> ['NIH', 'NSF'] (grant numbers dropped)."""
    names = (" ".join(_GRANT.sub(" ", part).split()) for part in _split(value))
    return _dedupe(name for name in names if name)  # "[123]" alone leaves nothing


# ------------------------------------------------------------------ entities


def _authors(articles: pd.DataFrame) -> list[list[Occurrence]]:
    """Authors with the ORCID merge and their per-article address."""
    df = articles.copy()
    df["row_pos"] = range(len(df))
    exploded = resolve_author_ids(extract_authors_with_metadata(df))
    address_cols = ("institution", "department", "city", "country")
    if "Addresses" in df:
        exploded = enrich_with_institution_data(exploded)
    out: list[list[Occurrence]] = [[] for _ in range(len(df))]
    for row in exploded.to_dict("records"):
        attrs = {c: row[c] for c in address_cols if c in row and pd.notna(row[c])}
        occurrences = out[row["row_pos"]]
        if all(o[0] != row["author_id"] for o in occurrences):  # listed twice on one paper
            occurrences.append((row["author_id"], row["display_name"], attrs))
    return out


def _all_institutions(articles: pd.DataFrame, field: str) -> list[list[Occurrence]]:
    """Institutions or countries of all authors (Addresses), once per article."""
    out: list[list[Occurrence]] = []
    for raw in articles["Addresses"]:
        found: dict[str, Occurrence] = {}
        for r in parse_address_block(raw):
            key = r[field]
            if not key or key in found:
                continue
            attrs = {} if field == "country" else {"city": r["city"], "country": r["country"]}
            found[key] = (key, key, {k: v for k, v in attrs.items() if v})
        out.append(list(found.values()))
    return out


def _corresponding_institution(articles: pd.DataFrame) -> list[list[Occurrence]]:
    """The corresponding author's institution (and department), one per article."""
    out: list[list[Occurrence]] = []
    for raw in articles["Reprint Addresses"]:
        anchor = pick_anchor_institution(parse_reprint_address_block(raw))
        if not anchor or not anchor["institution"]:
            out.append([])
            continue
        key = anchor["institution"]
        if anchor["department"]:
            key = f"{key} — {anchor['department']}"
        attrs = {
            c: anchor[c] for c in ("institution", "department", "city", "country") if anchor[c]
        }
        out.append([(key, key, attrs)])
    return out


def _list_entity(column: str, parse: Callable[[Any], list[str]] = _split):
    def extract(articles: pd.DataFrame) -> list[list[Occurrence]]:
        return [[(v, v, {}) for v in _dedupe(parse(raw)) if v] for raw in articles[column]]

    return extract


def _journals(articles: pd.DataFrame) -> list[list[Occurrence]]:
    out: list[list[Occurrence]] = []
    publishers = articles["Publisher"] if "Publisher" in articles else [None] * len(articles)
    for name, publisher in zip(articles["Source Title"], publishers, strict=True):
        name = _text(name)
        attrs = {"publisher": _text(publisher)} if _text(publisher) else {}
        out.append([(name, name, attrs)] if name else [])
    return out


def _articles(articles: pd.DataFrame) -> list[list[Occurrence]]:
    out: list[list[Occurrence]] = []
    columns = (ARTICLE_ID, "Article Title", "Source Title", "Publication Year", "Document Type")
    cols = [articles[c] if c in articles else [None] * len(articles) for c in columns]
    for ut, title, journal, year, doc_type in zip(*cols, strict=True):
        ut = _text(ut)
        if not ut:
            out.append([])
            continue
        attrs: dict[str, Any] = {}
        if _text(journal):
            attrs["journal"] = _text(journal)
        if year is not None and not pd.isna(year):
            attrs["year"] = str(int(year))
        if _text(doc_type):
            attrs["document_type"] = _text(doc_type)
        out.append([(ut, _text(title) or ut, attrs)])
    return out


Granularity = Literal["fine", "coarse", "article"]
"""fine: thousands of distinct values, links mostly weight 1 (a minimum link weight
thins them); coarse: about a hundred values, links weigh hundreds; article: one node
per article. Shown on the data page's node catalog (pipeline/profile.py)."""


@dataclass(frozen=True)
class EntitySpec:
    label: str
    columns: tuple[str, ...]
    many_per_article: bool
    extract: Callable[[pd.DataFrame], list[list[Occurrence]]]
    team_attribute: str | None = None
    role: str = "links"
    granularity: Granularity = "fine"


ENTITIES: dict[str, EntitySpec] = {
    "author": EntitySpec(
        "Author", ("Author Full Names",), True, _authors, "country", "linked authors"
    ),
    "institution": EntitySpec(
        "Institution (all authors)",
        ("Addresses",),
        True,
        lambda a: _all_institutions(a, "institution"),
        "country",
        "linked institutions",
    ),
    "corresponding_institution": EntitySpec(
        "Institution — department (corresponding author)",
        ("Reprint Addresses",),
        False,
        _corresponding_institution,
        "country",
        "linked institutions",
    ),
    "country": EntitySpec(
        "Country",
        ("Addresses",),
        True,
        lambda a: _all_institutions(a, "country"),
        None,
        "linked countries",
        granularity="coarse",
    ),
    "organization": EntitySpec(
        "Organization (Affiliations)",
        ("Affiliations",),
        True,
        _list_entity("Affiliations"),
        None,
        "linked organizations",
    ),
    "journal": EntitySpec(
        "Journal", ("Source Title",), False, _journals, "publisher", "linked journals"
    ),
    "funder": EntitySpec(
        "Funder",
        ("Funding Orgs",),
        True,
        _list_entity("Funding Orgs", _funders),
        None,
        "linked funders",
    ),
    "wos_category": EntitySpec(
        "WoS category",
        ("WoS Categories",),
        True,
        _list_entity("WoS Categories"),
        None,
        "linked categories",
        granularity="coarse",
    ),
    "research_area": EntitySpec(
        "Research area",
        ("Research Areas",),
        True,
        _list_entity("Research Areas"),
        None,
        "linked research areas",
        granularity="coarse",
    ),
    "article": EntitySpec(
        "Article",
        (ARTICLE_ID,),
        False,
        _articles,
        "document_type",
        "linked articles",
        granularity="article",
    ),
}


# ------------------------------------------------------------------ link fields

LinkKind = Literal["same_article", "list", "string"]


@dataclass(frozen=True)
class LinkSpec:
    label: str
    columns: tuple[str, ...]
    kind: LinkKind
    models: tuple[Model, ...]
    values: Callable[[pd.DataFrame], list[list[str]]]
    edge_type: str


def _list_values(*columns: str, parse: Callable[[Any], list[str]] = _split):
    def values(articles: pd.DataFrame) -> list[list[str]]:
        present = [c for c in columns if c in articles]
        return [
            _dedupe(item for c in present for item in parse(row[c]))
            for _, row in articles[present].iterrows()
        ]

    return values


def _string_values(column: str):
    def values(articles: pd.DataFrame) -> list[list[str]]:
        return [[t] if (t := _text(v)) else [] for v in articles[column]]

    return values


def _same_article(articles: pd.DataFrame) -> list[list[str]]:
    return [[_text(v)] if _text(v) else [] for v in articles[ARTICLE_ID]]


STRING_MODELS: tuple[Model, ...] = ("word_overlap", "character_similarity")

LINKS: dict[str, LinkSpec] = {
    "same_article": LinkSpec(
        "Same article (co-occurrence)",
        (ARTICLE_ID,),
        "same_article",
        ("word_matching",),
        _same_article,
        "co_occurs_with",
    ),
    "keywords": LinkSpec(
        "Keywords (author keywords + Keywords Plus)",
        ("Author Keywords", "Keywords Plus"),
        "list",
        ("word_matching",),
        _list_values("Author Keywords", "Keywords Plus"),
        "shares_keywords_with",
    ),
    "author_keywords": LinkSpec(
        "Author keywords",
        ("Author Keywords",),
        "list",
        ("word_matching",),
        _list_values("Author Keywords"),
        "shares_author_keywords_with",
    ),
    "keywords_plus": LinkSpec(
        "Keywords Plus",
        ("Keywords Plus",),
        "list",
        ("word_matching",),
        _list_values("Keywords Plus"),
        "shares_keywords_plus_with",
    ),
    "wos_categories": LinkSpec(
        "WoS categories",
        ("WoS Categories",),
        "list",
        ("word_matching",),
        _list_values("WoS Categories"),
        "shares_categories_with",
    ),
    "research_areas": LinkSpec(
        "Research areas",
        ("Research Areas",),
        "list",
        ("word_matching",),
        _list_values("Research Areas"),
        "shares_research_areas_with",
    ),
    "funders": LinkSpec(
        "Funders",
        ("Funding Orgs",),
        "list",
        ("word_matching",),
        _list_values("Funding Orgs", parse=_funders),
        "shares_funders_with",
    ),
    "organizations": LinkSpec(
        "Organizations (Affiliations)",
        ("Affiliations",),
        "list",
        ("word_matching",),
        _list_values("Affiliations"),
        "shares_organizations_with",
    ),
    "authors": LinkSpec(
        "Authors",
        ("Author Full Names",),
        "list",
        ("word_matching",),
        _list_values("Author Full Names"),
        "shares_authors_with",
    ),
    "article_title": LinkSpec(
        "Article title",
        ("Article Title",),
        "string",
        STRING_MODELS,
        _string_values("Article Title"),
        "similar_titles",
    ),
    "journal": LinkSpec(
        "Journal (Source Title)",
        ("Source Title",),
        "string",
        STRING_MODELS,
        _string_values("Source Title"),
        "similar_journals",
    ),
    "abstract": LinkSpec(
        "Abstract",
        ("Abstract",),
        "string",
        ("word_overlap",),
        _string_values("Abstract"),
        "similar_abstracts",
    ),
    "funding_text": LinkSpec(
        "Funding text",
        ("Funding Text",),
        "string",
        ("word_overlap",),
        _string_values("Funding Text"),
        "similar_funding_text",
    ),
}


def combination_problem(entity: str, link: str, model: str) -> str | None:
    """Why this combination can't be built, or None when it can."""
    if entity not in ENTITIES:
        return f"Unknown entity {entity!r}"
    if link not in LINKS:
        return f"Unknown link field {link!r}"
    if model not in MODELS:
        return f"Unknown model {model!r}"
    e, lk = ENTITIES[entity], LINKS[link]
    if model not in lk.models:
        allowed = ", ".join(MODELS[m] for m in lk.models)
        return f"{lk.label} can be compared with: {allowed}"
    if set(e.columns) & set(lk.columns):
        return f"{e.label} can't be linked by its own field"
    if lk.kind == "same_article" and not e.many_per_article:
        return f"{e.label} has one value per article, so it never co-occurs with another"
    return None


def availability(column_fill: dict[str, float]) -> dict[str, dict[str, str | None]]:
    """For each entity and link field: None if the data supports it, else why not.

    ``column_fill`` maps column name -> % of articles with a value (the profile's
    ``non_empty_pct``). A field needs at least one of its columns filled in
    MIN_FILL_PCT of the articles.
    """

    def problem(columns: tuple[str, ...]) -> str | None:
        best = max((column_fill.get(c, 0.0) for c in columns), default=0.0)
        if best >= MIN_FILL_PCT:
            return None
        names = " / ".join(columns)
        if best == 0:
            return f"{names} is empty or missing in this dataset"
        return f"{names} is filled in only {best:.0f}% of the articles"

    return {
        "entities": {k: problem(e.columns) for k, e in ENTITIES.items()},
        "links": {k: problem(lk.columns) for k, lk in LINKS.items()},
    }


# ------------------------------------------------------------------ models
# Each returns {(i, j): evidence} for matched article pairs (i <= j, positions in
# the article frame). Evidence: shared items (word matching) or "a ~ b" pairs.

Pairs = dict[tuple[int, int], set[str]]


def _add_pair(pairs: Pairs, i: int, j: int, evidence: str) -> None:
    key = (i, j) if i <= j else (j, i)
    bucket = pairs.get(key)
    if bucket is None:
        if len(pairs) >= MAX_ARTICLE_PAIRS:
            raise NetworkBuildError(
                f"These options match more than {MAX_ARTICLE_PAIRS:,} pairs of articles. "
                "Raise the minimum (shared items or similarity) or lower the maximum share."
            )
        pairs[key] = bucket = set()
    bucket.add(evidence)


def word_matching(values: list[list[str]], min_shared: int, max_item_df: float) -> Pairs:
    """Article pairs sharing at least ``min_shared`` items (normalized like keywords).

    Items in more than ``max_item_df`` of the articles carry no signal and are
    ignored, as in the institution keyword network.
    """
    norm = [sorted({n for v in vs if (n := normalize_keyword(v))}) for vs in values]
    with_values = [i for i, vs in enumerate(norm) if vs]
    total = len(with_values)
    doc_freq = Counter(item for i in with_values for item in norm[i])
    eligible = {k for k, f in doc_freq.items() if total and f / total <= max_item_df}
    log.info(
        "Word matching: %d articles, %d items, %d eligible (<= %.0f%%)",
        total,
        len(doc_freq),
        len(eligible),
        100 * max_item_df,
    )
    by_item: dict[str, list[int]] = defaultdict(list)
    for i in with_values:
        for item in norm[i]:
            if item in eligible:
                by_item[item].append(i)
    shared: Pairs = {}
    for item, idxs in by_item.items():
        for i, j in combinations(idxs, 2):
            _add_pair(shared, i, j, item)
    return {p: items for p, items in shared.items() if len(items) >= min_shared}


_WORD = re.compile(r"[a-z0-9]+")
STOP_WORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "based",
        "by",
        "for",
        "from",
        "has",
        "have",
        "in",
        "into",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "that",
        "the",
        "their",
        "this",
        "to",
        "use",
        "used",
        "using",
        "via",
        "was",
        "were",
        "which",
        "with",
        "within",
        "without",
        "we",
        "our",
        "study",
        "analysis",
        "new",
        "approach",
    ]
)


def _words(text: str) -> frozenset[str]:
    return frozenset(w for w in _WORD.findall(text.lower()) if len(w) > 2 and w not in STOP_WORDS)


def _string_pairs(
    values: list[list[str]],
    threshold: float,
    max_word_df: float,
    score: Callable[[str, str, frozenset[str], frozenset[str]], float],
) -> Pairs:
    """Shared core of the string models.

    Compares distinct values (case-insensitive) that share at least one word used
    by at most ``max_word_df`` of the articles, so common words never make two
    values candidates; identical values always match.
    """
    by_value: dict[str, list[int]] = defaultdict(list)
    spelling: dict[str, str] = {}
    for i, vs in enumerate(values):
        for v in vs:
            key = " ".join(v.lower().split())
            if key:
                by_value[key].append(i)
                spelling.setdefault(key, v)
    keys = list(by_value)
    words = {k: _words(k) for k in keys}
    total = sum(1 for vs in values if vs)
    article_words: Counter = Counter()
    for k in keys:
        for w in words[k]:
            article_words[w] += len(by_value[k])
    rare = {w for w, f in article_words.items() if total and f / total <= max_word_df}

    by_word: dict[str, list[int]] = defaultdict(list)
    for n, k in enumerate(keys):
        for w in words[k] & rare:
            by_word[w].append(n)
    candidates: set[tuple[int, int]] = set()
    for idxs in by_word.values():
        for pair in combinations(idxs, 2):
            candidates.add(pair)
            if len(candidates) > MAX_CANDIDATE_PAIRS:
                raise NetworkBuildError(
                    "These options compare too many values. Lower the maximum share of "
                    "articles a word may appear in."
                )
    log.info(
        "String similarity: %d distinct values, %d rare words, %d candidate pairs",
        len(keys),
        len(rare),
        len(candidates),
    )

    pairs: Pairs = {}
    for k in keys:  # identical values: similarity 1
        for i, j in combinations(sorted(set(by_value[k])), 2):
            _add_pair(pairs, i, j, spelling[k])
    for a, b in candidates:
        ka, kb = keys[a], keys[b]
        if score(ka, kb, words[ka], words[kb]) < threshold:
            continue
        label = f"{spelling[ka]} ~ {spelling[kb]}"
        for i in by_value[ka]:
            for j in by_value[kb]:
                if i != j:
                    _add_pair(pairs, i, j, label)
    return pairs


def _jaccard(_a: str, _b: str, wa: frozenset[str], wb: frozenset[str]) -> float:
    union = wa | wb
    return len(wa & wb) / len(union) if union else 0.0


def _characters(a: str, b: str, _wa: frozenset[str], _wb: frozenset[str]) -> float:
    m = SequenceMatcher(None, a, b, autojunk=False)
    return m.ratio() if m.real_quick_ratio() and m.quick_ratio() else 0.0


def word_overlap(values: list[list[str]], threshold: float, max_word_df: float) -> Pairs:
    """Pairs whose texts share enough words: Jaccard of their word sets >= threshold."""
    return _string_pairs(values, threshold, max_word_df, _jaccard)


def character_similarity(values: list[list[str]], threshold: float, max_word_df: float) -> Pairs:
    """Pairs whose texts are spelled alike: difflib ratio >= threshold (0-1).

    Catches variants and typos ('Univ Toronto' ~ 'University of Toronto'); meant
    for short fields like titles and names.
    """

    def score(a: str, b: str, wa: frozenset[str], wb: frozenset[str]) -> float:
        # ratio() <= 2*min/(len a + len b): skip pairs that can't reach the threshold.
        if 2 * min(len(a), len(b)) / (len(a) + len(b)) < threshold:
            return 0.0
        return _characters(a, b, wa, wb)

    return _string_pairs(values, threshold, max_word_df, score)


# ------------------------------------------------------------------ graph


@dataclass(frozen=True)
class CustomParams:
    entity: str = "institution"
    link: str = "keywords"
    model: str = "word_matching"
    min_shared: int = 3
    max_item_df: float = 0.05
    threshold: float = 0.5
    max_word_df: float = 0.05
    min_weight: int = 1
    top_n: int = 300
    max_team_categories: int = 12
    min_team_size: int = 2


def build_custom_graph(articles: pd.DataFrame, params: CustomParams) -> nx.Graph:
    """Full (unsampled) graph for one entity / link field / model combination."""
    problem = combination_problem(params.entity, params.link, params.model)
    if problem:
        raise NetworkBuildError(problem)
    espec, lspec = ENTITIES[params.entity], LINKS[params.link]
    # The entity needs all of its columns; a link field one of them (keywords has two).
    missing = [c for c in espec.columns if c not in articles]
    if not any(c in articles for c in lspec.columns):
        missing += lspec.columns
    if missing:
        raise KeyError(", ".join(missing))
    articles = articles.reset_index(drop=True)

    entities = espec.extract(articles)
    values = lspec.values(articles)
    # Only articles with both an entity and a link value take part.
    values = [vs if entities[i] else [] for i, vs in enumerate(values)]

    if lspec.kind == "same_article":
        pairs: Pairs = {(i, i): set() for i, vs in enumerate(values) if vs}
    elif params.model == "word_matching":
        pairs = word_matching(values, params.min_shared, params.max_item_df)
    elif params.model == "word_overlap":
        pairs = word_overlap(values, params.threshold, params.max_word_df)
    else:
        pairs = character_similarity(values, params.threshold, params.max_word_df)
    log.info(
        "%s x %s (%s): %d matched article pairs",
        params.entity,
        params.link,
        params.model,
        len(pairs),
    )

    # Nodes: every entity of an article that has a link value.
    names: dict[str, Counter] = defaultdict(Counter)
    attrs: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    article_count: Counter = Counter()
    for i, occs in enumerate(entities):
        if not values[i]:
            continue
        for eid, name, occ_attrs in occs:
            names[eid][name] += 1
            article_count[eid] += 1
            for k, v in occ_attrs.items():
                attrs[eid][k][v] += 1
    G = nx.Graph()
    for eid, counts in names.items():
        node = {"display_name": counts.most_common(1)[0][0], "articles": article_count[eid]}
        for k, c in attrs[eid].items():
            node[k] = c.most_common(1)[0][0]
        G.add_node(eid, **node)

    titles = articles.get("Article Title")
    for (i, j), evidence in pairs.items():
        left = {e[0] for e in entities[i]}
        right = {e[0] for e in entities[j]}
        entity_pairs = {tuple(sorted((a, b))) for a in left for b in right if a != b}
        for a, b in entity_pairs:
            if G.has_edge(a, b):
                data = G[a][b]
                data["weight"] += 1
            else:
                G.add_edge(a, b, weight=1, _evidence=Counter())
                data = G[a][b]
            if lspec.kind == "same_article":
                if titles is not None and _text(titles.iloc[i]):
                    data["_evidence"][_text(titles.iloc[i])] += 1
            else:
                data["_evidence"].update(evidence)

    # Weak links (fewer matched article pairs than min_weight) are dropped; their
    # nodes stay, and sampling keeps connected components first.
    weak = [(u, v) for u, v, w in G.edges(data="weight") if w < params.min_weight]
    G.remove_edges_from(weak)
    if weak:
        log.info("Dropped %d links below weight %d", len(weak), params.min_weight)

    limit = MAX_EVIDENCE_ITEMS if lspec.kind != "string" else MAX_EVIDENCE_PAIRS
    for _, _, data in G.edges(data=True):
        ev: Counter = data.pop("_evidence")
        data["evidence"] = sorted(k for k, _ in ev.most_common(limit))
    log.info("Custom graph: %d nodes, %d edges", G.number_of_nodes(), G.number_of_edges())
    return G


def custom_network(articles: pd.DataFrame, params: CustomParams | None = None) -> dict:
    """Network JSON for a custom combination (see the module docstring)."""
    params = params or CustomParams()
    G = build_custom_graph(articles, params)
    espec, lspec = ENTITIES[params.entity], LINKS[params.link]
    node_attrs = tuple(sorted({k for _, d in G.nodes(data=True) for k in d} - {"display_name"}))
    network = graph_to_network(
        G,
        top_n=params.top_n,
        edge_type=lspec.edge_type,
        role_suffix=espec.role,
        team_attribute=espec.team_attribute,
        max_team_categories=params.max_team_categories,
        min_team_size=params.min_team_size,
        node_attrs=node_attrs,
        edge_attrs=("evidence",),
    )
    validate_network(network)
    return network
