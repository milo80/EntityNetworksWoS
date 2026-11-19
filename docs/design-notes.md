Project: WoS Bibliometric Network Explorer : Current State
What this project is
Turning Web of Science (WoS) bibliometric exports into an interactive, filterable
network-graph web app. Two halves, kept in sync via a shared JSON schema:

Python pipeline (entity_relation_generator*.py) — reads WoS .xls
exports, builds NetworkX graphs, exports web-ready JSON.
(Superseded in step 2: the pipeline is backend/pipeline/; the original script
is legacy/entity_relation_generator12.py.)
Frontend viewer (legacy/graph_network_prototype2.html) — a single
self-contained HTML file (Cytoscape.js) that loads any JSON matching the
schema below via a file picker, with filtering, search, and a synced
readable/JSON side panel.
(Superseded in step 5: the React app in frontend/ replaces it; the prototype
stays as the reference its parity test runs.)
(Removed after step 6: legacy/ is no longer in the repository; the prototype
and the original script are in git history.)

Relations built so far

Author co-authorship network — the primary, most-developed one. Nodes =
authors, edges = co-authorship on an article.
Institution/department network — nodes = institution (or
"institution — department"), edges = co-publication.
Country network — nodes = countries, edges = international collaboration.
(Superseded in step 2: the pipeline builds two relations, `author` and
`institution_keywords` (institutions linked by shared rare keywords). The
institution/department and country networks are commented out in the legacy
script and were not ported.)

Current JSON schema (the frontend's contract — don't change this shape without updating the frontend too)
(Superseded in step 3: the source of truth is backend/pipeline/schema.py and
the generated docs/network.schema.json. The sketch below shows the shape.)

```json
{
  "nodes": [
    {
      "id": "ORCID, or LOCAL-<hash>, or an institution/country name — never a raw author name",
      "name": "human-readable display name",
      "team": "drives node color + the Group filter — a real attribute (e.g. country) or a detected community",
      "role": "short description, e.g. '14 co-authors'",
      "attr": {
        "institution": "...",
        "department": "...",
        "city": "...",
        "author_keywords": ["...", "..."],
        "keywords_plus": ["...", "..."]
      }
    }
  ],
  "edges": [
    {
      "source": "id",
      "target": "id",
      "type": "collaborates_with | co_publishes_with | ...",
      "weight": 1
    }
  ]
}
```

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
Measured on the 3,000-article sample: an article with n authors yields
n(n-1)/2 pairs, so the 3.6% of articles with >15 authors produce 58% of all
co-author pairs (the largest has 220 authors). Without the cut, the author
network goes from 42.6k to 76.5k links (top degree 42 -> 112) and institutions
by keywords from 8.2k to 13.4k (top degree 119 -> 191). It filters articles,
so it applies to every relationship; the form shows it under "More options"
as the "Articles" group.
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
(Superseded in steps 4-5: there is now a backend with login that stores
datasets and builds the networks. Filtering itself still runs in the browser,
in frontend/src/lib/visibility.ts.)

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
(Superseded in step 5: networks load from the API; a local JSON file can still
be opened in the Explorer at /local, and it is never uploaded.)

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
(Superseded in step 4: the FastAPI backend was built, see "Back-end (step 4)".)



Pipeline refactor notes (step 2)

The legacy script now lives in backend/pipeline/ (io, authors, institutions,
keywords, networks, sampling, export, relations, cli). Behavior is unchanged
except for two determinism fixes:
- input files are read in sorted order (glob order is filesystem-dependent);
- build_connected_sample() no longer iterates Python sets of node ids, so the
  sample (and node/edge order) no longer varies with PYTHONHASHSEED. Degree ties
  are broken by the graph's node insertion order.
Because of this, legacy/outputs/*.json (removed with legacy/; produced by a slightly older script
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
  Correct only for a single API process - which is the deployment model (the
  rule is in deploy/README.md, "Limits").
- Password reset by emailed one-time link: a random 256-bit token, stored only
  as SHA-256 (like sessions), single-use, valid PASSWORD_RESET_TTL_MINUTES (30),
  and a new request voids older links. The request endpoint always answers 202
  with the same text and does the lookup and the sending in a background task,
  so neither the content nor the timing reveals whether an account exists.
  Setting a password ends all of the user's sessions. Mail goes over SMTP with
  stdlib smtplib (no extra service); without SMTP_HOST the message is logged
  instead. Admins can also set a password and create accounts from the command
  line (app.manage, see "Accounts" in README.md); ALLOW_REGISTRATION=false
  closes signup.
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
restart. Deployment must guarantee a single worker (the rule is in
deploy/README.md, "Limits"); more workers would need a heartbeat column
instead. Step 6 enforces it: the worker holds a PostgreSQL
advisory lock for its lifetime, on a connection detached from the pool (closing a
pooled connection only returns it to the pool, which would keep the lock), so a
second worker exits with an error.

Network responses are served straight from Postgres (JSONB cast to text, no
re-parse in Python) with ETag "run-<id>" (a succeeded run never changes) and
Cache-Control: private, no-cache, so repeat views are a cheap 304.

Tests: tests/api/ runs against a real PostgreSQL (JSONB, SKIP LOCKED) using
TEST_DATABASE_URL; the schema is rebuilt from the Alembic migrations each
session. Worker tests use tests/fixtures/synthetic_wos.py (made-up records, safe
to commit), so they also run in CI without the licensed WoS sample.

Known open items:
- (Fixed 2026-11-16) Tests and the smoke test use `httpx2` instead of `httpx`,
  as Starlette's TestClient asks (it warned with `httpx`). httpx2 is published
  from github.com/pydantic/httpx2 by httpx's author (BSD-3); it brings
  `httpcore2` and `truststore` (system trust store for TLS). Dev-only: the
  images install `[api]` without it.
- (Fixed in step 6) uvicorn's access log lines are now JSON too
  (`app/log_config.json`).

Smoke test (backend/scripts/smoke_test.py)

pytest runs the app in-process (TestClient, worker called as a function), so it
can't see process-level problems. The smoke test checks the assembled system
from the outside: a real server, a separate worker process, real cookies and
multipart uploads, configuration from the environment. It is not a substitute
for the API tests (most of its checks are also covered there) and is not part
of the pytest suite, since it needs running servers. Step 6 runs it in CI after
`docker compose up` and after each deploy; it exits non-zero on the first
failure and cleans up after itself.
(Not yet: CI runs it only against the stack on its own runner. After a deploy
it is run by hand from the dev machine; running it from CI against QA is a
target.)
Crash recovery is not covered by the smoke test: it is checked manually,
locally, by killing the worker mid-run (steps in README.md, "Smoke test").


Frontend (step 5)

Pages: Login/Register; Datasets (list, upload, "open local file"); Dataset
(networks with live status, Build network form, delete); Dataset data (profile:
overview figures, articles per year, top-10 lists, columns, sample rows); and
the Explorer (/runs/:id, or /local for a local JSON file that is never uploaded).
No separate Runs page: runs always belong to a dataset.

Explorer: every prototype rule is kept (lib/visibility.ts; a parity test runs
the prototype itself in jsdom and compares; it was removed with legacy/, and
visibility.test.ts covers the rules). Layout changes: filters | graph |
details with the graph at 50% initially and draggable (and keyboard-resizable)
dividers; no cards inside panels; the group filter list doubles as the legend
(color swatch + count), so there is no separate legend row; attribute search
sits behind an "Attribute search" disclosure; a selection box at the top of the
details panel shows the clicked node/link with all its attributes; clicking an
entry in the Readable list selects and centres it in the graph. Below 1024 px
the side panels become toggleable drawers.
(Added after step 7: a "Link weight" range in the filters panel hides links
outside a chosen window of weights - shared articles, or matched article pairs,
per link - in the graph, the Readable list and the JSON alike. It steps over the
distinct weights that exist rather than a linear scale, because weights are very
skewed (most links often have weight 1), and shows a histogram of links per
weight. It hides links only; a "Hide nodes
without visible links" checkbox, off by default, also hides nodes left without a
visible link, including nodes that never had one. It replaces a planned
build-time "strongest k links per node" cap: the reader picks the window after
the build, so one run serves several views.)
(Removed at the same time: the Relationship checkboxes. Every network the app
builds has a single link type, so they never filtered anything; the rule stays
in lib/visibility.ts with every type checked.)

Group colors: the 7 largest groups get the first 7 slots of the reference
categorical palette in its fixed order (blue, orange, aqua, yellow, magenta,
green, violet), assigned once per network (colors never repaint when
filtering); all other groups and "other" are neutral gray; "unknown" is a
hollow node (distinct from "other" without relying on color). A network graph
is an all-pairs color problem (any two groups can sit side by side), and the
palette validator fails 7 colors there: worst normal-vision pair blue/violet
dE 10.5 (floor 15), worst color-blind pair green/orange dE 3.2. Only 4 colors
pass all-pairs; 7 was chosen by the product owner for now, accepting that some
pairs are hard to tell apart. Group names in the Group filter (the legend), the
tooltip and the details panel are the secondary encoding. The prototype cycled
7 colors over up to 22 groups, so different countries shared a color; here they
never do (groups past the 7th are gray).

Graph layout: cytoscape-fcose (spectral placement + force-directed refinement)
with uniformNodeDimensions and initialEnergyOnIncremental 0.1. Measured headless
on the 700-node / 3022-link author network: built-in cose 7.5 s (about 15 s in
the browser), fcose defaults 4.1 s, fcose draft 0.3 s, chosen settings ~0.9 s.
The layout still runs on the main thread when a network opens; if larger
networks make that too slow, the next step is computing positions once in the
worker and storing them with the run.

Graph labels: Cytoscape scales text with the zoom; node labels are kept at a
constant 14 px on screen (the Readable list's size) by re-evaluating the font
size on zoom, and are shown only at zoom >= 1, except for search matches and
the selected node.

Dataset profile: computed by the worker right after upload (pipeline/profile.py),
served by GET /api/datasets/{id}/profile; the API still never parses uploads.
Fixed a hash-seed-dependent ordering of tied keyword counts (set iteration)
found by the fixture-consistency test.
Node catalog (profile version 2): for every custom-network node type the
columns allow (custom.ENTITIES, article excluded), the number of distinct
values, the share of articles with one, and the top 10 values counted in
articles. The data page groups them by EntitySpec.granularity: fine-grained
(author, institutions, organization, journal, funder: thousands of values,
links mostly weight 1) and coarse (country, WoS category, research area: about
a hundred values, links weigh hundreds), so users can choose what to compare
before building. Authors are counted by name: the network's ORCID identity
takes ~12 s on 3,000 articles, names ~0.1 s (whole profile ~0.5 s). It replaces
the corresponding-author country and institution lists. Profile version 3 adds
the link catalog (custom.LINKS): share of articles with each field; for list
fields the distinct items (normalized as word matching compares them) and,
unless the field is a node type's own column (then the page points to that
node card), the top 10; for text fields the median word count. The data page
shows both as one Catalog: Nodes fine-grained, Nodes coarse and Linked by
(the keyword lists moved there). When the worker has
nothing pending it recomputes one 'ready' profile older than PROFILE_VERSION
in place (the old one stays visible meanwhile; a failure is remembered in
refresh_failed_version and not retried), so existing datasets update without
a migration.
Profile version 4 keeps the top 20 values per catalog entry (CATALOG_TOP_N;
other lists stay at 10). The data page still shows 10; the Create network form
shows the 20 beside a Custom build: the chosen node type's values on the left,
the chosen link field's on the right (a field that is a node type's own column
shows that node's values; co-occurrence and text fields say what they contain),
stacked under 1100px. The Nodes select groups its options like the catalog
(Fine-grained, Coarse, Other) and both selects carry their group's color as a
left border; the group names are the primary encoding, color the secondary.

Bundling: the Explorer (Cytoscape, ~146 KB gzip) is lazy-loaded; the rest of the
app is ~100 KB gzip.


Deployment (step 6)

Docker Compose: web (Caddy + built UI), api, worker, db, and a one-off migrate
service that api/worker wait for. The same compose.yaml runs with Docker and
Podman. Only Caddy publishes ports. Images: python:3.14-slim (non-root, pip
installs pinned by backend/constraints.txt), node build stage + caddy:alpine.
The Caddyfile is mounted, not baked in, so one web image serves every site.

Caddy: automatic TLS (Let's Encrypt for a domain, its local CA for localhost),
zstd/gzip, HSTS, a strict CSP (default-src 'self', no 'unsafe-inline'; React
and Cytoscape set styles through the DOM, which CSP allows), nosniff,
Referrer-Policy, Permissions-Policy, frame-ancestors 'none', no Server header
(uvicorn runs with --no-server-header). request_body max_size closes the
upload-size limitation above: oversized requests get 413 before the API.
Hashed /assets/* are cached immutable, everything else no-cache.

API process: one uvicorn process, because the rate limiter keeps its counts
in memory (rule: deploy/README.md, "Limits"); --proxy-headers so the rate
limiter sees the client IP from Caddy.

CI without licensed data: backend/tests/fixtures/synthetic_wos.xls is the
synthetic fixture written as a real legacy .xls (scripts/make_synthetic_xls.py,
xlwt; a test keeps it in sync). The CI "stack" job builds the images, starts
the stack over HTTPS, runs the smoke test with --proxy (UI served, deep links,
security headers, compressed network JSON), checks that a second worker
refuses to start, runs the Playwright journey (desktop and tablet widths; fails
on any console error, which is how CSP violations surface) and the backup
script. mypy now runs in CI (pydantic plugin; pandas/networkx untyped).

Not done: no server exists yet, so nothing is deployed; deploy/README.md is the
runbook. Images are built on the server from git; a registry (GHCR) and
automated deploys come when there is a server to deploy to.
(Superseded after step 6: infra/ (Terraform) creates one server per
environment, QA and PROD, and infra/server.sh deploys them. Servers no longer
build: CI's stack job pushes the images it tested to GHCR, tagged with the
commit SHA, and servers pull those, so a server can only run a commit CI
passed, and the image that runs is the one that was tested. PROD gets the
commit QA runs (promotion). Deploys are still started by hand. How:
infra/README.md and deploy/README.md.)


Custom networks (step 7)

Besides the two fixed relations, a network can be built from three choices
(backend/pipeline/custom.py): the nodes (an entity), the field that links them,
and the model that compares that field. All combinations share one algorithm:
each article gets its entities; the model finds the pairs of articles that match
on the link field; two entities are linked once per matched article pair in
which they appear on opposite sides, never with themselves (weight = number of
matched article pairs). "Same article" is the link where each article matches
itself, which gives co-occurrence networks: Author x Same article is
co-authorship. Corresponding institution x Keywords x word matching equals the
institution keyword relation exactly (tested on the synthetic data, checked on
the real sample: 2,040 nodes, 3,213 edges, same weights). The author preset
counts an article twice when WoS lists an author twice on it; the custom engine
counts it once.

Curated catalog, not any column: WoS exports always have the same columns, and
the useful ones need parsing (ORCID merge for authors, institutions and
countries inside Addresses, grant numbers inside Funding Orgs). An entity is a
categorical value that names a real thing, repeats across articles (Article
itself is the exception), and is filled in at least 20% of a dataset's articles
(MIN_FILL_PCT); numbers, dates, IDs and free text don't qualify. Link fields are
lists (";"-separated items: keywords, categories, funders, organizations,
authors) or strings (title, journal, abstract, funding text). Availability per
dataset comes from the stored profile's column fill, so no recompute is needed.
A link field can't be the entity's own column, and Same article needs an entity
with several values per article.

Models:
- word matching (list fields): article pairs sharing at least N items,
  normalized like keywords; items in more than a share of the articles are
  ignored (the institution keyword logic, generalized).
- string similarity, word overlap: Jaccard of the word sets (lowercased, stop
  words and words under 3 letters dropped) >= threshold.
- string similarity, characters: difflib SequenceMatcher ratio >= threshold;
  catches spelling variants ("Univ Toronto" ~ "University of Toronto"). Only
  offered for short fields (title, journal): it is too slow for abstracts.
Both string models compare distinct values, and only values that share a word
used by at most a share of the articles (default 5%): an inverted index keeps
the comparisons far below all pairs. Identical values always match. Measured
on the 3,000-article sample: titles 0.2 s, abstracts about 11 s.

Defaults (measured on the 3,000-article sample with the wos-explore skill, and
checked against published practice: VOSviewer and bibliometrix defaults,
deduplication and name-matching studies): word matching needs 3 shared items, each in at most 5% of the
articles; word overlap 0.5; characters 0.9 (published name-matching cutoffs are
0.85-0.95, and different authors such as "zhang wei" / "zhang wen" already score
0.89). The first defaults (2 items, 12%) gave institution and organization
networks an average degree of 87-216 on 300 nodes; the new ones give 4-22 for
every entity. A minimum link weight (matched article pairs per link, default 1)
drops weak links before sampling. It defaults to 1 because Article nodes only
ever have weight-1 links; for authors and institutions 87-99% of links have
weight 1, so 2 thins them a lot. For coarse entities (countries, categories)
weights run into the hundreds and even 10 leaves a near-complete graph.
The Build network form doesn't show this option, because at 1 it drops nothing
and the Explorer's link weight range filters links on screen. It remains an API
parameter (`min_weight`).

Limits: a run that would match more than 2,000,000 article pairs (or score more
than 5,000,000 value pairs) fails with a message asking for a stricter setting,
instead of exhausting the worker's memory. Standard library only (difflib, re):
no new dependency.
