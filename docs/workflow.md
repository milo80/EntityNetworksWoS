# Workflow: local -> CI -> QA -> PROD

The day-to-day commands in one place, in the order a change goes through them.
Each section links to the file that explains them (**Details**). This file
repeats the commands on purpose, so you can work from it alone.

**Where commands run.** On this machine, podman runs only on the **host**: the
dev database, the Compose stack, `infra/tf.sh` and `infra/server.sh` (which also
needs SSH). The backend venv, npm, the tests, `git`, `gh` and `curl` run in the
**toolbox**. `tf.sh` needs the AWS keys in your shell (`AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`); `server.sh` needs only SSH. Directories below are
relative to the repository root.

**Server addresses.** A server's URL is `https://<ip with dashes>.sslip.io`, for
example `https://3-120-45-67.sslip.io` for 3.120.45.67. Below, `<qa-url>` and
`<prod-url>` stand for those, and `<qa-ip>` and `<prod-ip>` for the IPs. Host,
in `infra/`:

```bash
./tf.sh qa output -raw public_ip
```

```bash
./tf.sh prod output -raw public_ip
```

## Agents: who does what

Claude Code does the work through agents defined in `.claude/agents/`. Each step
hands a concrete output to the next one, and **you** sign off at three checkpoints
(stories, dev, QA) and run every deploy.

| # | Who | Input | Output | Next step when |
|---|---|---|---|---|
| 1 | `analyst` | your request | stories and ACs in [`requirements.md`](requirements.md), status *Proposed*, open questions | — |
| 2 | **you** | the stories | approval or changes | you approve → *Approved* |
| 3 | `developer` | the approved stories | code and tests, AC → test references, local checks green, status *In progress* | checks pass |
| 4 | `qa-reviewer` (+ `e2e-tester` for browser tests) | the diff and the stories | findings, a met/not-met table per AC, CI-equivalent check results | verdict "ready for dev validation"; otherwise back to 3 |
| 5 | **you** | the running dev app (§1–2) | "validated in dev" | — |
| 6 | `developer` | your validation | branch, commit, PR, merge after CI passes (§3) | CI on `main` is green |
| 7 | `deployer` | the merged commit | CI status confirmed and the QA command printed | — |
| 8 | **you** | the command | `./server.sh qa deploy` run (§4) | — |
| 9 | `deployer` | the QA URL | health, login page, version and smoke test results | all pass; otherwise roll back or go to 3 |
| 10 | **you** | QA | "validated in QA", status *Done* | you decide on PROD |
| 11 | `deployer` | your PROD decision | the PROD command printed | — |
| 12 | **you** | the command | `./server.sh prod deploy` run (§5) | — |
| 13 | `deployer` | the PROD URL | read-only checks only: health, login page, version. Nothing is created | — |

A small fix with no behavior change (a typo, a dependency bump) can skip steps 1–2. Every other
step still applies. Tests trace back to requirements: each AC in `requirements.md` names
its tests, and `backend/tests/test_requirements_trace.py` fails CI when one is missing.

## 1. Local development (fastest loop)

**Details:** "Setup" and "Back-end" in [`README.md`](../README.md#back-end-local-development),
[`frontend/README.md`](../frontend/README.md#commands).

First time only. Toolbox, in `backend/`:

```bash
python3.14 -m venv .venv && .venv/bin/pip install -c constraints.txt -e '.[api,dev]'
```

Toolbox, in `frontend/`:

```bash
npm ci
```

Host, any directory (creates the dev database):

```bash
podman run -d --name entitynet-db \
  -e POSTGRES_USER=entitynet -e POSTGRES_PASSWORD=entitynet -e POSTGRES_DB=entitynet \
  -p 127.0.0.1:5432:5432 -v entitynet-pgdata:/var/lib/postgresql/data \
  docker.io/library/postgres:16
```

Every session. Host, any directory:

```bash
podman start entitynet-db
```

Toolbox, in `backend/` (migrations, then the API on :8000, API docs at
`/api/docs`):

```bash
.venv/bin/alembic upgrade head
COOKIE_SECURE=false .venv/bin/uvicorn app.main:app --reload
```

The chat assistant is off unless `ANTHROPIC_API_KEY` is set: put it in `backend/.env`
(a copy of `../.env.example`), or export it in that terminal, then restart the API.

Toolbox, in `backend/`, second terminal (exactly one worker):

```bash
.venv/bin/python -m app.worker
```

Toolbox, in `frontend/`, third terminal (the UI at http://localhost:5173):

```bash
npm run dev
```

Registration is open locally. To create an admin account instead (asks for the
password), toolbox, in `backend/`:

```bash
.venv/bin/python -m app.manage create-user you@example.org --admin
```

### Tests

**Details:** "Tests" in [`README.md`](../README.md#tests),
[`frontend/README.md`](../frontend/README.md#tests).

Toolbox, in `backend/` (the same checks as CI):

```bash
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy && .venv/bin/python -m pytest
```

Toolbox, in `frontend/`:

```bash
npm test && npm run lint && npm run typecheck
```

Smoke test against the API and worker above. Toolbox, in `backend/`:

```bash
.venv/bin/python scripts/smoke_test.py --register \
    --email smoke@example.org --password 'some-long-password' \
    --golden tests/fixtures/golden/network_author.json
```

After changing the API, regenerate `docs/openapi.json` and
`frontend/src/api/schema.d.ts` (the `/api-change` skill does it); CI checks them.

## 2. Local full stack (the same containers as CI and the servers)

**Details:** "Run it locally" in [`deploy/README.md`](../deploy/README.md#run-it-locally-or-in-ci).

First time only. Toolbox, in `deploy/`:

```bash
cp .env.example .env
```

Then edit `deploy/.env` and set:

```
POSTGRES_PASSWORD=<letters and digits>
ALLOW_REGISTRATION=true
HTTP_PORT=8080
HTTPS_PORT=8443
PUBLIC_BASE_URL=https://localhost:8443
```

Optional: `ANTHROPIC_API_KEY=<key>` in the same file turns on the chat assistant
(see "Assistant" in [`deploy/README.md`](../deploy/README.md#assistant-claude-api)).

Host, in `deploy/` (then open https://localhost:8443):

```bash
podman compose up -d --build
```

Smoke test. Toolbox, in `backend/`:

```bash
.venv/bin/python scripts/smoke_test.py --base-url https://localhost:8443 --insecure --proxy \
    --register --email smoke@example.org --password 'some-long-password' --wos-dir tests/fixtures
```

Browser tests. Toolbox, in `frontend/` (the toolbox reads the API log through
`flatpak-spawn --host`; without `E2E_API_LOGS_CMD` the password reset test is
skipped):

```bash
E2E_BASE_URL=https://localhost:8443 E2E_API_LOGS_CMD='cd ../deploy && flatpak-spawn --host podman compose logs --no-color api' npm run e2e
```

Stop the stack. Host, in `deploy/` (keeps the data; `down -v` would delete it):

```bash
podman compose down
```

## 3. Commit, then CI decides

**Details:** "Images" in [`deploy/README.md`](../deploy/README.md#images),
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

Toolbox, in the repository root:

```bash
git push origin main
```

```bash
gh run watch $(gh run list -L1 --json databaseId -q '.[0].databaseId') --exit-status
```

A green run on `main` publishes `ghcr.io/milo80/entitynetworks-{api,web}:<commit sha>`.
Servers never build images, so they can only deploy commits CI passed.

## 4. QA

**Details:** "`server.sh`" and "Save and rebuild QA" in
[`infra/README.md`](../infra/README.md#serversh-deploy-and-save).

Deploy `origin/main` (it backs up first and keeps `.env`). Host, in `infra/`:

```bash
./server.sh qa deploy
```

Toolbox, any directory:

```bash
curl -s <qa-url>/api/health
```

Smoke test against QA. Registration is off there, so the account must exist
(create it as in [Admin tasks](#admin-tasks-either-server)). Toolbox, in `backend/`:

```bash
SMOKE_EMAIL=smoke@example.org SMOKE_PASSWORD=<password> .venv/bin/python scripts/smoke_test.py \
    --base-url <qa-url> --proxy --wos-dir tests/fixtures
```

Rebuild QA from scratch, or destroy it to save money and create it again later.
Before destroying, host, in `infra/` (`save` prints the backup directory):

```bash
./server.sh qa save
./tf.sh qa destroy
```

Later, host, in `infra/` (a new IP, so a new URL; `deploy` asks for the SMTP
settings again):

```bash
./tf.sh qa apply
./server.sh qa deploy --restore envs/qa/backups/<time>
```

## 5. PROD (only after QA is tested)

**Details:** "PROD" in [`infra/README.md`](../infra/README.md#prod).

Promote the commit QA runs (answer `y`). Host, in `infra/`:

```bash
./server.sh prod deploy
```

Check it. Toolbox, any directory:

```bash
curl -s <prod-url>/api/health
```

Host, any directory (prints the full commit SHA of the images PROD runs; it must
equal the commit QA runs, and `/api/health` doesn't report a version):

```bash
ssh ubuntu@<prod-ip> "sed -n 's/^TAG=//p' /opt/entitynetworks/deploy/.env"
```

Extra local copy of the latest backup, into `envs/prod/backups/<time>/`. Host,
in `infra/`:

```bash
./server.sh prod save
```

**Restore from S3:** in the S3 console, download a `db-<time>.dump` and its
`uploads-<time>.tar.gz` into a new directory (rename `.tar` back to `.tar.gz` if
the browser dropped it; details in "Off-server copies" in
[`deploy/README.md`](../deploy/README.md#off-server-copies-s3)). Then host, in `infra/`:

```bash
./server.sh prod deploy --restore <dir>
```

**Destroy:** termination protection is on; set `termination_protection = false`
in `envs/prod/main.tf` and apply first.

## Admin tasks (either server)

**Details:** "Accounts on a server" and "Email" in
[`deploy/README.md`](../deploy/README.md#accounts-on-a-server).

Host, any directory. Create an account (leave out `--admin` for a normal user):

```bash
ssh -t ubuntu@<ip> 'cd /opt/entitynetworks/deploy && docker compose exec api python -m app.manage create-user you@example.org --admin'
```

Set someone's password (also ends their sessions):

```bash
ssh -t ubuntu@<ip> 'cd /opt/entitynetworks/deploy && docker compose exec api python -m app.manage set-password someone@example.org'
```

Follow the logs:

```bash
ssh -t ubuntu@<ip> 'cd /opt/entitynetworks/deploy && docker compose logs -f api worker'
```

Change the email (SMTP) settings. `--smtp` runs a full `deploy`, which would also
deploy `origin/main` (QA) or QA's commit (PROD). To keep the version the server
runs, print it, then pass it as `--ref`. Host, in `infra/`:

```bash
ssh ubuntu@<ip> "sed -n 's/^TAG=//p' /opt/entitynetworks/deploy/.env"
```

```bash
./server.sh <env> deploy --smtp --ref <commit>
```

## Parallel work with git worktrees

A worktree is a second checkout of the repository in another directory, on its
own branch (`git worktree add ../EntityNetworks-<topic> -b <topic>`). In this project:

- Each worktree needs its own `.venv` and `node_modules`: create them there, never copy them.
- Run the Compose stack from one worktree at a time: `compose.yaml` sets
  `name: entitynetworks`, so stacks from two worktrees share containers, the
  database volume and ports 8080/8443. The dev database on :5432 is shared too.
- `deploy/.env` and the Terraform state are git-ignored and stay in the main
  checkout: run `tf.sh` and `server.sh` from there.
- Only `main` reaches the servers: CI publishes images for pushes to `main`, and
  `server.sh qa deploy` deploys `origin/main`. Merge a branch to deploy it.
