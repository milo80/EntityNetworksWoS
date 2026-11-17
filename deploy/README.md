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

On a server made with `infra/` (Terraform), `infra/server.sh qa deploy` does all of
this, plus saving and restoring the data across a rebuild: see `infra/README.md`.
By hand:

Needs: a Linux VM with Docker (Compose v2) and ~2 GB RAM, a domain whose DNS A/AAAA
record points at it, and ports 80 and 443 open (Let's Encrypt needs 80).

```
git clone <repo> /opt/entitynetworks && cd /opt/entitynetworks/deploy
cp .env.example .env
#   SITE_ADDRESS=entitynetworks.example.org
#   POSTGRES_PASSWORD=$(openssl rand -hex 24)
#   ALLOW_REGISTRATION=false
#   TAG=$(git rev-parse --short HEAD)
#   SMTP_* for password reset emails (see "Email" below)
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

## Email (password reset)

"Forgot password" on the login page emails a one-time link (valid 30 minutes,
works once; using it logs the user out everywhere). The API sends it over SMTP
with the `SMTP_*` values in `.env`; `.env.example` shows a Gmail setup. Use an
account made only for sending, with an app password, so a leaked `.env` exposes
nothing but an empty mailbox.

Without `SMTP_HOST` nothing is sent and the link is written to the API log:

```
docker compose logs api | grep reset-password
```

Test it after setting SMTP up: ask for a reset for your own account and check
that the email arrives (also look in spam) and its link opens this site. If
email isn't working, an admin can set a password directly (this also logs the
user out):

```
docker compose exec api python -m app.manage set-password someone@example.org
```

## Updating

On a server made with `infra/`, run `infra/server.sh qa deploy` from your machine.
It backs up, then switches to the images CI built and tested for the commit
(`ghcr.io/milo80/entitynetworks-{api,web}:<full SHA>`) without building
anything on the server. By hand, on the server:

```
cd /opt/entitynetworks && git fetch && git checkout --detach <commit>
cd deploy && sed -i "s/^TAG=.*/TAG=$(git rev-parse HEAD)/" .env   # with IMAGE_PREFIX=ghcr.io/milo80/ in .env
./backup.sh && docker compose pull api web && docker compose up -d --no-build
```

A server without `IMAGE_PREFIX` builds its own images instead (`docker compose up -d --build`).

`migrate` applies new migrations before api/worker restart. The worker finishes
the network build it is running before it stops (up to 2 minutes). To roll back,
check out the previous commit and run the same commands. A migration that
changed the schema needs the database backup restored.

## Backups

`./backup.sh` writes `backups/db-<time>.dump` (pg_dump, custom format) and
`backups/uploads-<time>.tar.gz`, keeping 14 days (`KEEP_DAYS`). With Podman:
`COMPOSE="podman compose" ./backup.sh`. Daily cron, in the crontab of the user that
runs the stack (`crontab -e`; the log goes to that user's home, since `/var/log`
needs root):

```
15 3 * * *  /opt/entitynetworks/deploy/backup.sh >> $HOME/entitynetworks-backup.log 2>&1
```

**Copy the backups off the server.** A backup that lives only on the VM is lost
with the VM. With `BACKUP_S3_URI=s3://<bucket>/` in `.env`, `backup.sh` also
uploads both files there (pinned `amazon/aws-cli` container, credentials from the
server's IAM role). On PROD, `infra/server.sh` sets this from the bucket Terraform
creates; see "PROD" in `infra/README.md`.

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
- **Images come from CI.** On every push to `main` that passes, the CI `stack` job
  pushes the images it tested to GHCR, tagged with the commit SHA. Servers pull
  those; only local runs and CI build.
