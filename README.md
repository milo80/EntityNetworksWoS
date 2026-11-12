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
- Step 4 (done): FastAPI back-end - auth, dataset upload, network runs, worker,
  Alembic migrations, API tests against PostgreSQL.
- UI and deployment: not implemented yet.

## Setup

    cd backend
    python3 -m venv .venv && .venv/bin/pip install -e '.[api,dev]'

## Pipeline only (no database)

    .venv/bin/python -m pipeline.cli ../data/wos -o out/      # writes network_*.json

Relations: `author` (co-authorship) and `institution_keywords` (shared rare
keywords). See `python -m pipeline.cli --help` for options.

## Back-end (local development)

PostgreSQL 16 on localhost:5432. On Fedora Silverblue the toolbox has no
podman, so start it **on the host** (the toolbox shares the host network):

    podman run -d --name entitynet-db \
      -e POSTGRES_USER=entitynet -e POSTGRES_PASSWORD=entitynet -e POSTGRES_DB=entitynet \
      -p 127.0.0.1:5432:5432 -v entitynet-pgdata:/var/lib/postgresql/data \
      docker.io/library/postgres:16

Then, from `backend/` (copy `../.env.example` to `.env` to change settings):

    .venv/bin/alembic upgrade head                                  # create/upgrade tables
    COOKIE_SECURE=false .venv/bin/uvicorn app.main:app --reload     # API on :8000, docs at /api/docs
    .venv/bin/python -m app.worker                                  # in a second terminal
    .venv/bin/python -m app.manage create-user you@example.org --admin

Run exactly one worker (see docs/design-notes.md).

## Tests

    .venv/bin/python -m pytest

- API tests use the database in `TEST_DATABASE_URL` (default
  `entitynet_test` on localhost, created automatically, wiped every session);
  they are skipped if PostgreSQL isn't reachable.
- Golden and real-data end-to-end tests need `data/wos/`; skipped otherwise.

## API

| Method | Path | |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | session cookie + CSRF token |
| GET | `/api/auth/me` | current user + CSRF token |
| POST/GET | `/api/datasets` | upload WoS `.xls` files (multipart: `name`, `files`) / list |
| GET/DELETE | `/api/datasets/{id}` | |
| POST/GET | `/api/runs` | queue `{dataset_id, relation, params?}` / list |
| GET/DELETE | `/api/runs/{id}` | status: queued, running, succeeded, failed |
| GET | `/api/runs/{id}/network`, `/api/runs/{id}/export` | network JSON (ETag) / as download |
| GET | `/api/health` | |

Every POST/DELETE must send the `X-CSRF-Token` header (value from login/me or
the `entitynet_csrf` cookie).

## Data

Place WoS exports (`.xls`, sheet `savedrecs`) in `data/wos/`. They are not
committed because they are licensed source data.
