# EntityNetworks

Turns Web of Science (WoS) bibliometric exports into interactive researcher /
institution networks (co-authorship, shared-keyword collaboration).

## Layout

| Path | Contents |
|---|---|
| `backend/pipeline/` | WoS -> NetworkX -> network JSON (refactor of the legacy script) |
| `backend/app/` | FastAPI service: auth, datasets, network runs, worker |
| `backend/tests/` | pytest (pipeline golden snapshots, API tests) |
| `frontend/` | React + TypeScript + Vite UI (Cytoscape.js graph explorer) |
| `deploy/` | Docker Compose, Caddyfile, backup script |
| `docs/` | Design notes and `network.schema.json` (generated: `python -m pipeline.schema`) |
| `legacy/` | Original demo, kept as the reference implementation |
| `data/wos/` | Raw WoS `.xls` exports (local only, git-ignored) |

## Status

- Step 1 (done): repository skeleton.
- Step 2 (done): pipeline refactored into `backend/pipeline/` with golden tests.
- Step 3 (done): network JSON contract as a Pydantic model (`backend/pipeline/schema.py`),
  enforced on every pipeline run; JSON Schema in `docs/network.schema.json`.
- API, UI and deployment: not implemented yet.

## Pipeline quick start

    cd backend
    python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
    .venv/bin/python -m pipeline.cli ../data/wos -o out/      # writes network_*.json
    .venv/bin/python -m pytest                                 # golden tests need data/wos/

Relations: `author` (co-authorship) and `institution_keywords` (shared rare
keywords). See `python -m pipeline.cli --help` for options.

## Data

Place WoS exports (`.xls`, sheet `savedrecs`) in `data/wos/`. They are not
committed because they are licensed source data.
