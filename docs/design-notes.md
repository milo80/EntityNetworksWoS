Project: WoS Bibliometric Network Explorer : Current State
What this project is
Turning Web of Science (WoS) bibliometric exports into an interactive, filterable
network-graph web app. Two halves, kept in sync via a shared JSON schema:

Python pipeline (entity_relation_generator*.py) — reads WoS .xls
exports, builds NetworkX graphs, exports web-ready JSON.
Frontend viewer (network_graph_prototype.html) — a single
self-contained HTML file (Cytoscape.js) that loads any JSON matching the
schema below via a file picker, with filtering, search, and a synced
readable/JSON side panel.

Relations built so far

Author co-authorship network — the primary, most-developed one. Nodes =
authors, edges = co-authorship on an article.
Institution/department network — nodes = institution (or
"institution — department"), edges = co-publication.
Country network — nodes = countries, edges = international collaboration.

Current JSON schema (the frontend's contract — don't change this shape without updating the frontend too)
{  "nodes": [    {      "id": "ORCID, or LOCAL-<hash>, or an institution/country name — never a raw author name",      "name": "human-readable display name",      "team": "drives node color + the Group filter — a real attribute (e.g. country) or a detected community",      "role": "short description, e.g. '14 co-authors'",      "attr": { "institution": "...", "department": "...", "city": "...",                "author_keywords": ["...", "..."], "keywords_plus": ["...", "..."] }    }  ],  "edges": [    { "source": "id", "target": "id", "type": "collaborates_with | co_publishes_with | ...", "weight": 1 }  ]}

attr is optional per node, display/search-only — it never drives graph
color or the Group/Relationship filters. This applies for Author co-authorship network
team has two distinct "no real value" states, kept separate on purpose:
"other" (a real value exists but didn't make the top-N categories) vs.
"unknown" (no value at all). Don't conflate them. This is used for catalogs/groups,

Key design decisions already made — don't relitigate without a good reason

Author identity: author_id = ORCID when resolvable via WoS's ORCIDs
field, else a deterministic LOCAL-<12-char sha1 hash> code. Never a raw
name. display_name carries the actual name for everything user-facing.
Mega-paper filtering: articles with >15 authors are dropped before the
graph is built (filter_out_mega_papers) — otherwise one huge consensus
paper forms an artificial clique that dominates degree-based sampling.
Sampling: build_connected_sample() samples from the largest connected
component(s), not raw top-N-by-degree — top-N-by-degree can produce a
near-disconnected sample once mega-papers are removed.
"team" grouping: prefer a real attribute (team_attribute='country')
over algorithmic community detection wherever one exists — a reader can
verify "Canada," not "cluster_3."
Institution/department parsing: from WoS's Addresses field bracket
notation, matched per-article (the same person can have different
affiliations on different papers).
Known limitation: US/Canada-style addresses can put state/province in the
city slot instead of the true city. Institution and country are unaffected.
This one has to be reviewd the authors-explode is generating unacurate addreses
for authors, address should be attached to article-institution. TODO: create new
attribure article-institution-address.
Keywords: list-valued, unioned across all of an author's articles,
deduped case-insensitively — not "most common single value" like institution.
Frontend filtering is 100% client-side, no backend, by design — appropriate
at current scale (tens–low hundreds of nodes). Revisit only if the dataset
grows into the thousands or needs to be live/access-controlled.

Frontend UI conventions established

Group / Relationship filters: checkboxes, hide non-matching nodes+edges.
Name search: highlights matches only, doesn't hide anything.
Search by Attributes: rows built from the union of attr keys in the
loaded file; + adds a row from remaining unused keys; comma-separated
terms within one row = OR; multiple rows = AND; nothing filters until
"Apply Search" is clicked.
Right panel: Readable / JSON toggle — both always reflect the same
filtered subset as the graph, because all three share one
visibleNodes()/visibleEdges() source of truth. Keep it that way.
Clicking a graph node highlights the matching entry in whichever
right-panel tab is open.
Data loading: file picker (<input type="file"> + FileReader) is the
reliable path — opening the HTML via file:// blocks plain fetch() of
local files. A best-effort fetch('network_sample.json') auto-load exists
as a bonus for when the page is served over http.

Working conventions for this project

Test Python changes against the real uploaded WoS sample before delivering —
a pandas duplicate-index overwrite bug and a stale default-argument override
were both only caught this way.
Test frontend logic changes with a headless DOM (jsdom), simulating real
user interaction via dispatched DOM events — not by reaching into
script-internal state, which doesn't reflect how a browser actually works.
Build one relation/feature at a time; confirm before moving to the next.
When a feature has more than one reasonable design, lay out the options and
tradeoffs before implementing rather than picking silently.

Not yet built / explicitly deferred

Thesaurus/synonym-based keyword matching (semantic, not just substring) —
waiting on a thesaurus file from the user.
Keyword co-occurrence as its own relation/dataset.
A backend/API layer — deferred until data scale or access-control needs
actually require it.



Pipeline refactor notes (step 2)

The legacy script now lives in backend/pipeline/ (io, authors, institutions,
keywords, networks, sampling, export, relations, cli). Behavior is unchanged
except for two determinism fixes:
- input files are read in sorted order (glob order is filesystem-dependent);
- build_connected_sample() no longer iterates Python sets of node ids, so the
  sample (and node/edge order) no longer varies with PYTHONHASHSEED. Degree ties
  are broken by the graph's node insertion order.
Because of this, legacy/outputs/*.json (produced by a slightly older script
version, non-reproducibly) are NOT the test reference; the reference is
backend/tests/fixtures/golden/, byte-identical to the legacy script with only
those two fixes applied.
export_graph_to_json() became export.graph_to_network(), which returns a dict;
file writing is pipeline.io.write_network_json(). Console prints became logging.
.xls files are read with the calamine engine (xlrd is deprecated in pandas 3);
both engines produce identical DataFrames on the sample data.
