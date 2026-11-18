# Deployment

One Linux server runs the whole stack with Docker Compose (or Podman):

```
browser --HTTPS--> web (Caddy: TLS, security headers, gzip, the built UI)
                     └─ /api/* --> api (FastAPI) --> db (PostgreSQL 16)
                                   worker ----------/
                                   api + worker share the "uploads" volume
```

| File | Purpose |
|---|---|
| `compose.yaml` | The services above, plus `migrate` (runs `alembic upgrade head` once before api/worker start) |
| `Caddyfile` | Site address, TLS, headers (CSP, HSTS...), request size cap, SPA routing, cache headers |
| `.env.example` | Settings: copy to `.env` (never committed) |
| `backup.sh` | Database dump + uploaded files, with retention and an optional S3 copy |
| `../backend/Dockerfile` | API/worker image (Python 3.14, non-root, pinned dependencies) |
| `../frontend/Dockerfile` | Web image (builds the UI, serves it with Caddy) |

The QA and PROD servers are created and deployed with `infra/` (Terraform and
`server.sh`): see [`infra/README.md`](../infra/README.md). This file is the
reference for the stack itself and for doing the same steps by hand.

## Run it locally (or in CI)

In `deploy/`, create `.env` once:

```
cp .env.example .env
```

and set, for a local run:

```
POSTGRES_PASSWORD=<letters and digits>
ALLOW_REGISTRATION=true
HTTP_PORT=8080
HTTPS_PORT=8443
PUBLIC_BASE_URL=https://localhost:8443
```

Rootless Podman can't bind ports below 1024, hence 8080/8443. Then build and
start the stack:

```
docker compose up -d --build
```

(or `podman compose up -d --build`). Open https://localhost:8443. The
certificate comes from Caddy's own local CA, so the browser warns once.

Check the running stack end to end with the smoke test (see "Smoke test" in the
[root README](../README.md#smoke-test-running-system)) and the browser tests
(see [`frontend/README.md`](../frontend/README.md#tests)). From `backend/`:

```
.venv/bin/python scripts/smoke_test.py --base-url https://localhost:8443 --insecure --proxy \
    --register --email smoke@example.org --password 'some-long-password' --wos-dir tests/fixtures
```

From `frontend/`:

```
E2E_BASE_URL=https://localhost:8443 E2E_API_LOGS_CMD='cd ../deploy && docker compose logs --no-color api' npm run e2e
```

CI (`.github/workflows/ci.yml`, job `stack`) does the same on every push, plus
a check that a second worker refuses to start and a run of `backup.sh`.

Stop the stack with `docker compose down`. That keeps the data; `down -v` also
deletes the volumes (database, uploads, certificates).

## Images

The images are built once, in CI, and servers run exactly those. On every push
to `main` that passes, CI's `stack` job pushes the images it tested to GHCR as
`ghcr.io/milo80/entitynetworks-{api,web}:<full commit SHA>`. Two settings in
`.env` choose the images:

- `IMAGE_PREFIX=ghcr.io/milo80/` and `TAG=<full commit SHA>`: pull CI's images.
  Servers use this and run `docker compose up -d --no-build`, so a server can
  only run a commit CI passed.
- No `IMAGE_PREFIX` (local runs and CI): `docker compose up -d --build` builds
  the images from the checkout, tagged `TAG` (default `local`).

## First deployment to a server (by hand)

`infra/server.sh deploy` does all of this on a server made with `infra/`, plus
saving and restoring the data across a rebuild: see
[`infra/README.md`](../infra/README.md#serversh-deploy-and-save).

Needs: a Linux VM with Docker (Compose v2) and ~2 GB RAM, a domain whose DNS A/AAAA
record points at it, and ports 80 and 443 open (Let's Encrypt needs 80). CI must
have passed on the commit you deploy.

```
git clone https://github.com/milo80/EntityNetworksWoS.git /opt/entitynetworks
cd /opt/entitynetworks && git checkout --detach <commit>
cd deploy && (umask 077 && cp .env.example .env)
openssl rand -hex 24
git rev-parse HEAD
```

Edit `.env` and set:

```
SITE_ADDRESS=<domain>
POSTGRES_PASSWORD=<the openssl output>
ALLOW_REGISTRATION=false
IMAGE_PREFIX=ghcr.io/milo80/
TAG=<the git rev-parse output>
```

and the `SMTP_*` values (see [Email](#email-password-reset)). Compose reads
`.env` literally: it does not run `$(...)`, so paste the values. Then start
the stack and create the first admin:

```
docker compose pull api web
docker compose up -d --no-build
docker compose exec api python -m app.manage create-user you@example.org --admin
```

Then:
1. Run the smoke test against the server from your machine, with a dedicated
   account created as in [Accounts on a server](#accounts-on-a-server): see
   "Smoke test" in the [root README](../README.md#smoke-test-running-system).
2. Check the headers from outside, e.g. https://securityheaders.com.
3. Add the backup cron job ([Backups](#backups)) and an uptime check on
   `https://<domain>/api/health`.

## Updating (by hand)

On the server, check out the new commit, point `TAG` at it, back up, and switch
to its images (CI must have passed on it):

```
cd /opt/entitynetworks && git fetch && git checkout --detach <commit>
cd deploy && sed -i "s/^TAG=.*/TAG=$(git rev-parse HEAD)/" .env
./backup.sh && docker compose pull api web && docker compose up -d --no-build
```

`migrate` applies new migrations before api/worker restart. The worker finishes
the network build it is running before it stops (up to 2 minutes). To roll back,
check out the previous commit and run the same commands. A migration that
changed the schema needs the database backup restored ([Backups](#backups)).

## Accounts on a server

Registration is off on servers (`ALLOW_REGISTRATION=false`). An admin creates
accounts and resets passwords with the commands in "Accounts" in the
[root README](../README.md#accounts), run in the `api` container, in `deploy/`:

```
docker compose exec api python -m app.manage create-user you@example.org --admin
docker compose exec api python -m app.manage set-password someone@example.org
```

## Email (password reset)

"Forgot password" on the login page emails a one-time link (valid 30 minutes,
works once; using it logs the user out everywhere). The API sends it over SMTP
(port 587, STARTTLS) with the `SMTP_*` values in `.env`; `.env.example` shows a
Gmail setup. Use an account made only for
sending, with an app password, so a leaked `.env` exposes nothing but an empty
mailbox. On servers made with `infra/`, `server.sh deploy` asks for these
values (see [`infra/README.md`](../infra/README.md#serversh-deploy-and-save)).

Without `SMTP_HOST` nothing is sent and the link is written to the API log:

```
docker compose logs api | grep reset-password
```

Test it after setting SMTP up: ask for a reset for your own account and check
that the email arrives (also look in spam) and its link opens this site. If
email isn't working, an admin can set the password directly with `set-password`
([Accounts on a server](#accounts-on-a-server)).

## Backups

`./backup.sh` writes `backups/db-<time>.dump` (pg_dump, custom format) and
`backups/uploads-<time>.tar.gz`, both owner-only, and deletes copies older than
14 days (`KEEP_DAYS`; `BACKUP_DIR` changes the folder). With Podman:
`COMPOSE="podman compose" ./backup.sh`.

Daily cron, in the crontab of the user that runs the stack (`crontab -e`; the
log goes to that user's home, since `/var/log` needs root). `server.sh deploy`
adds it on servers made with `infra/`:

```
15 3 * * *  /opt/entitynetworks/deploy/backup.sh >> $HOME/entitynetworks-backup.log 2>&1
```

### Off-server copies (S3)

A backup that lives only on the VM is lost with the VM. With
`BACKUP_S3_URI=s3://<bucket>/` in `.env`, `backup.sh` also uploads both files
there, with a pinned `amazon/aws-cli` container and the credentials of the
server's IAM role. On PROD, Terraform creates the bucket and the role and
`server.sh` sets `BACKUP_S3_URI` (see "PROD" in
[`infra/README.md`](../infra/README.md#prod)). The role may only add files, so
copies are downloaded in the S3 console (the bucket -> the file -> Download).
Download a `db-<time>.dump` and the `uploads-<time>.tar.gz` with the same time
into a new directory. Browsers may save the uploads file as
`uploads-<time>.tar`: it is still gzip-compressed, so rename it back to
`.tar.gz`.

### Restore

On a server made with `infra/`, `server.sh <env> deploy --restore <dir>` does
this: see [`infra/README.md`](../infra/README.md#save-and-rebuild-qa). By hand,
with the stack running, in `deploy/` (this replaces the current data):

```
docker compose stop api worker
docker compose exec -T db pg_restore -U entitynet -d entitynet --clean --if-exists < backups/db-<time>.dump
docker compose run --rm --no-deps -T api sh -c 'rm -rf /data/uploads/* && tar -C /data -xzf -' < backups/uploads-<time>.tar.gz
docker compose run --rm migrate
docker compose start api worker
```

`migrate` brings a backup made by older code up to the current schema.

## Limits and rules of this setup

- **One worker, one API process.** Run exactly one worker and a single API
  process (no `uvicorn --workers`), locally as well as on servers. The worker
  holds a PostgreSQL advisory lock, so a second one logs an error and exits; a
  second API process would split the in-memory rate limiter. Why: see "Worker /
  queue" and "API process" in [`docs/design-notes.md`](../docs/design-notes.md).
  More than one needs a code change, not a setting.
- **Uploads** are capped twice: Caddy rejects request bodies over
  `MAX_REQUEST_BODY` (default 510 MB) with 413, the API rejects files over
  `MAX_UPLOAD_MB` (default 50) each and more than `MAX_FILES_PER_DATASET`
  (default 10). Change them together.
- **Logs** are JSON lines on stdout (API, worker, Caddy): `docker compose logs -f api worker`.
- **No high availability**: if the VM is lost, rebuild it from these steps and the
  off-server backups.
