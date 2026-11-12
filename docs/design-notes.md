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


Network JSON contract (step 3)

The schema above is now formal: backend/pipeline/schema.py (Pydantic) is the
single source of truth; docs/network.schema.json is generated from it with
`python -m pipeline.schema` (a test fails if it is stale). Every relation built
by pipeline.relations is validated before it is returned. Rules:
- strict types, no coercion; unknown fields are rejected (on nodes, edges and root);
- node ids unique and non-empty; team non-empty ("other" / "unknown" reserved);
- edges must reference existing nodes; weight is an integer >= 1;
- no self-loops, and no duplicate edge of the same type between the same pair
  (direction ignored);
- attr values: string, number, or list of strings; empty values are omitted, not null.

Self-loop fix: WoS sometimes lists an author twice on one paper ("Hu, Zhixi;
Hu, Zhixi"), which produced an author->same-author edge and inflated the
"N co-authors" role by 2. create_author_network() now skips same-identity pairs.
Effect on the sample data: one edge removed (3023 -> 3022) and one role fixed
(6 -> 4 co-authors); nothing else changed. Goldens were regenerated.


Back-end (step 4)

Layout: backend/app/ - config.py (env settings), db.py, models/ (User,
UserSession, Dataset, DatasetFile, NetworkRun), auth/ (passwords, sessions +
CSRF, rate limiter), api/ (routers), services/ (upload storage, run -> pipeline
call), worker.py, manage.py (create-user). Migrations in backend/alembic/.

Decisions that differ from the original plan, and why:
- Sessions, not JWT: a random 256-bit token in an httpOnly, SameSite=Lax
  cookie (Secure in production - enforced at startup); the DB stores only its
  SHA-256. Logout and account deactivation take effect immediately, which a
  stateless JWT can't do without a denylist.
- CSRF: synchronizer token stored with the session, exposed in a readable
  cookie and in the login/me response; every POST/PUT/PATCH/DELETE must echo it
  in X-CSRF-Token.
- Rate limiting: a small in-memory fixed-window limiter instead of slowapi.
  Correct only for a single API process - which is the deployment model.
- No password reset yet: it needs an email service. Admins can create accounts
  with `python -m app.manage create-user`; ALLOW_REGISTRATION=false closes signup.
- Login failures for unknown emails and wrong passwords return the same
  response and take the same time (Argon2 verify runs against a dummy hash).

Uploads: only legacy .xls (OLE2 signature D0CF11E0...) is accepted - that is
what WoS exports. Files are streamed to <UPLOAD_DIR>/<dataset_id>/<random>.xls,
never under the user's name, with SHA-256 and size recorded. Contents are
parsed only by the worker. LIMITATION: the size check runs while the handler
copies the file, i.e. after Starlette has already received the whole request
into a temporary file - the reverse proxy (Caddy, step 6) must cap the request
body size.

File order: the pipeline is order-sensitive (first-seen keyword spelling, degree
tie-breaks). Stored names are random, so the worker reads a dataset's files
sorted by original file name. Results therefore don't depend on upload order,
and match `pipeline.cli` run on the same folder (verified by the real-data
end-to-end test, which uploads in reverse order).

Worker / queue: network_runs is the queue (SELECT ... FOR UPDATE SKIP LOCKED).
On startup the worker requeues runs left 'running' (up to WORKER_MAX_ATTEMPTS,
then marks them failed). This assumes exactly ONE worker process: a second
worker starting up would requeue a run the first is still processing. Seen in
practice during smoke testing, when a previous session's processes survived a
restart. Deployment must guarantee a single worker; more workers would need a
heartbeat column instead.

Network responses are served straight from Postgres (JSONB cast to text, no
re-parse in Python) with ETag "run-<id>" (a succeeded run never changes) and
Cache-Control: private, no-cache, so repeat views are a cheap 304.

Tests: tests/api/ runs against a real PostgreSQL (JSONB, SKIP LOCKED) using
TEST_DATABASE_URL; the schema is rebuilt from the Alembic migrations each
session. Worker tests use tests/fixtures/synthetic_wos.py (made-up records, safe
to commit), so they also run in CI without the licensed WoS sample.

Known open items:
- Starlette warns that its TestClient will want the `httpx2` package instead of
  `httpx`. Not switched yet: the package wasn't vetted. Harmless for now.
- uvicorn's own access log lines are plain text, not JSON like the app logs;
  give uvicorn a log config in step 6.

Smoke test (backend/scripts/smoke_test.py)

pytest runs the app in-process (TestClient, worker called as a function), so it
can't see process-level problems. The smoke test checks the assembled system
from the outside: a real server, a separate worker process, real cookies and
multipart uploads, configuration from the environment. It is not a substitute
for the API tests (most of its checks are also covered there) and is not part
of the pytest suite, since it needs running servers. Step 6 runs it in CI after
`docker compose up` and after each deploy; it exits non-zero on the first
failure and cleans up after itself.
Crash recovery is checked manually, locally: queue a run, `kill -9` the worker
while the run is 'running', start a new worker, and it logs "Recovered 1
orphaned run(s)" and finishes the run. (When finding the worker PID, don't use
`pgrep -f 'app.worker'` from a script - it also matches the script's own shell.)


Frontend (step 5)

Pages: Login/Register; Datasets (list, upload, "open local file"); Dataset
(networks with live status, Build network form, delete); Dataset data (profile:
overview figures, articles per year, top-10 lists, columns, sample rows); and
the Explorer (/runs/:id, or /local for a local JSON file that is never uploaded).
No separate Runs page: runs always belong to a dataset.

Explorer: every prototype rule is kept (lib/visibility.ts; a parity test runs
the prototype itself in jsdom and compares). Layout changes: filters | graph |
details with the graph at 50% initially and draggable (and keyboard-resizable)
dividers; no cards inside panels; the group filter list doubles as the legend
(color swatch + count), so there is no separate legend row; attribute search
sits behind an "Attribute search" disclosure; a selection box at the top of the
details panel shows the clicked node/link with all its attributes; clicking an
entry in the Readable list selects and centres it in the graph. Below 1024 px
the side panels become toggleable drawers.

Group colors: a network graph is an all-pairs color problem (any two groups can
sit side by side). Validated with the dataviz palette validator, the largest
subset of the reference categorical palette passing all-pairs in light mode
without CVD warnings is 4 colors (blue #2a78d6, yellow #eda100, magenta
#e87ba4, green #008300; worst CVD dE 13, normal-vision dE 19.6). So the 4
largest groups are colored, assigned once per network (colors never repaint
when filtering); all other groups and "other" are neutral gray; "unknown" is a
hollow node (distinct from "other" without relying on color). Yellow and
magenta are below 3:1 contrast, which is acceptable because every group is
also named in the filter list and the details panel. The prototype cycled 7
colors over up to 22 groups, which made different countries share a color.

Dataset profile: computed by the worker right after upload (pipeline/profile.py),
served by GET /api/datasets/{id}/profile; the API still never parses uploads.
Fixed a hash-seed-dependent ordering of tied keyword counts (set iteration)
found by the fixture-consistency test.

Bundling: the Explorer (Cytoscape, ~146 KB gzip) is lazy-loaded; the rest of the
app is ~100 KB gzip.
