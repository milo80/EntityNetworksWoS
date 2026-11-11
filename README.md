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
| `docs/` | Design notes and the network JSON schema contract |
| `legacy/` | Original demo, kept as the reference implementation |
| `data/wos/` | Raw WoS `.xls` exports (local only, git-ignored) |

## Status

Step 1 of the migration plan: repository skeleton. Pipeline, API, UI and
deployment are not implemented yet.

## Data

Place WoS exports (`.xls`, sheet `savedrecs`) in `data/wos/`. They are not
committed because they are licensed source data.
