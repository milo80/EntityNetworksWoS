# Deployment

One Linux server runs the whole stack with Docker Compose (or Podman):

```
browser --HTTPS--> web (Caddy: TLS, security headers, gzip, the built UI)
                     └─ /api/* --> api (FastAPI, 1 process) --> db (PostgreSQL 16)
                                   worker (exactly 1) ---------/
                                   api + worker share the "uploads" volume
```

| File | Purpose |
|---|---|
| `compose.yaml` | The services above, plus `migrate` (runs `alembic upgrade head` once before api/worker start) |
| `Caddyfile` | Site address, TLS, headers (CSP, HSTS...), request size cap, SPA routing, cache headers |
| `.env.example` | Settings: copy to `.env` (never committed) |
| `backup.sh` | Database dump + uploaded files, with retention |
| `../backend/Dockerfile` | API/worker image (Python 3.14, non-root, pinned dependencies) |
| `../frontend/Dockerfile` | Web image (builds the UI, serves it with Caddy) |

## Run it locally (or in CI)

```
cd deploy
cp .env.example .env          # set POSTGRES_PASSWORD; for local use also:
                              #   ALLOW_REGISTRATION=true HTTP_PORT=8080 HTTPS_PORT=8443
docker compose up -d --build  # or: podman compose up -d --build
```

Open https://localhost:8443. The certificate comes from Caddy's own local CA, so
the browser warns once. Check the running stack end to end:

```
cd ../backend
.venv/bin/python scripts/smoke_test.py --base-url https://localhost:8443 --insecure --proxy \
    --register --email smoke@example.org --password 'some-long-password' --wos-dir tests/fixtures
cd ../frontend && E2E_BASE_URL=https://localhost:8443 npm run e2e
```

CI (`.github/workflows/ci.yml`) does exactly this on every push.

## First deployment to a server

Needs: a Linux VM with Docker (Compose v2) and ~2 GB RAM, a domain whose DNS A/AAAA
record points at it, and ports 80 and 443 open (Let's Encrypt needs 80).

```
git clone <repo> /opt/entitynetworks && cd /opt/entitynetworks/deploy
cp .env.example .env
#   SITE_ADDRESS=entitynetworks.example.org
#   POSTGRES_PASSWORD=$(openssl rand -hex 24)
#   ALLOW_REGISTRATION=false
#   TAG=$(git rev-parse --short HEAD)
chmod 600 .env
docker compose up -d --build
docker compose exec api python -m app.manage create-user you@example.org --admin
```

Then:
1. Smoke test against the server, with a dedicated account (create it as above):
   `SMOKE_EMAIL=... SMOKE_PASSWORD=... python scripts/smoke_test.py --base-url https://<domain> --proxy --wos-dir <dir with .xls>`
2. Check the headers from outside, e.g. https://securityheaders.com.
3. Add the backup cron job (below) and an uptime check on `https://<domain>/api/health`.

Use the same steps for a staging server (its own domain and `.env`) before production.

## Updating

```
cd /opt/entitynetworks && git pull
cd deploy && sed -i "s/^TAG=.*/TAG=$(git rev-parse --short HEAD)/" .env
./backup.sh && docker compose up -d --build
```

`migrate` applies new migrations before api/worker restart. The worker finishes
the network build it is running before it stops (up to 2 minutes). To roll back,
check out the previous commit and run the same commands. A migration that
changed the schema needs the database backup restored.

## Backups

`./backup.sh` writes `backups/db-<time>.dump` (pg_dump, custom format) and
`backups/uploads-<time>.tar.gz`, keeping 14 days (`KEEP_DAYS`). With Podman:
`COMPOSE="podman compose" ./backup.sh`. Daily cron:

```
15 3 * * *  /opt/entitynetworks/deploy/backup.sh >> /var/log/entitynetworks-backup.log 2>&1
```

**Copy the backups off the server** (rclone/rsync to object storage or another
machine). A backup that lives only on the VM is lost with the VM.

Restore (stack running; this replaces the current data):

```
docker compose stop api worker
docker compose exec -T db pg_restore -U entitynet -d entitynet --clean --if-exists < backups/db-<time>.dump
docker compose run --rm --no-deps -T api sh -c 'rm -rf /data/uploads/* && tar -C /data -xzf -' \
    < backups/uploads-<time>.tar.gz
docker compose start api worker
```

## Limits and rules of this setup

- **One worker, one API process.** The worker holds a PostgreSQL advisory lock:
  a second worker logs an error and exits. The API's login/upload rate limiter
  is in memory, so the API must stay a single process (no `--workers`).
- **Uploads** are capped twice: Caddy rejects request bodies over
  `MAX_REQUEST_BODY` (default 510 MB) with 413, the API rejects files over
  `MAX_UPLOAD_MB` each and more than `MAX_FILES_PER_DATASET`. Change them together.
- **Logs** are JSON lines on stdout (API, worker, Caddy): `docker compose logs -f api worker`.
- **No high availability**: if the VM is lost, rebuild it from these steps and the
  off-server backups.
- Images are built on the server from the git checkout. Pushing prebuilt images
  to a registry (GHCR) is a later step if build time on the server becomes a problem.
