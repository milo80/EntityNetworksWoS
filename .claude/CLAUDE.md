# EntityNetworks: project notes for Claude

## Agents and workflow

Work goes from requirements to delivery through the agents in `.claude/agents/`,
in the order and with the hand-offs in `docs/workflow.md` ("Agents: who does what").

- **Delegate by default.** For a feature, bug fix or behavior change, use the agents
  without waiting to be asked. `analyst` writes the stories in `docs/requirements.md`, then
  I approve them. `developer` builds, then `qa-reviewer` (with `e2e-tester` for browser
  tests) reviews. After I validate in dev, `developer` merges once CI passes, and `deployer`
  prepares and checks the deploys.
- **Three checkpoints are mine:** approving stories, validating in dev, validating
  in QA. Don't move past one without my word.
- **I run every deploy.** `deployer` prints the `infra/server.sh` command and runs
  read-only checks afterwards. No agent deploys, pushes images or applies Terraform.
- **Requirements trace to tests.** Every acceptance criterion in
  `docs/requirements.md` names its tests. CI's `test_requirements_trace.py` enforces it.

## Network graph (Cytoscape) conventions

- **Labels keep a constant on-screen size at every zoom**, matching the
  side-panel text and font. Hide them at low zoom with `text-opacity`, not
  `min-zoomed-font-size`, but always label search matches and the selected
  node. Keep the zoom handler throttled. See `GraphView.tsx`.
- **Layout (fcose):** before changing its options, measure on
  `backend/tests/fixtures/golden/network_author.json`. Lowering `numIter`
  doesn't make it faster.
- **Group colors are stable:** assigned once per network by group size, never
  repainted by filters; overflow groups are gray, "unknown" is hollow. Group
  names in the UI are the secondary encoding. See `frontend/src/lib/colors.ts`
  and `docs/design-notes.md`.

## Deployment and tests

- **`deploy/compose.yaml` is the complete list of what runs.** No new service
  without approval (see the user-level rules).
- **Pinned runtimes:** Node 22 and PostgreSQL 16 everywhere, and the same Python
  version in the Dockerfile and local dev.
- **QA and PROD run the same stack.** Same images and compose services; only
  configuration differs. Images are built once in CI and promoted from QA to
  PROD without rebuilding: CI's `stack` job pushes the images it tested to GHCR
  (tag = commit SHA) and `infra/server.sh deploy` pulls them. Promotion is
  manual for now: `infra/server.sh prod deploy` deploys the commit QA runs.
  PROD has no domain yet (sslip.io, like QA) while it's a proof of concept.
- **Servers:** `infra/` (Terraform) creates one EC2 server per environment that
  runs `deploy/compose.yaml`. QA and PROD use the same module; only the values in
  `infra/envs/<env>/main.tf` differ, and each has its own state. No ECS until
  the app needs more than one instance (it runs one API process and one worker).
- **Tests run in CI, not on servers.** Unit and integration tests run in CI jobs
  on throwaway runners. The smoke test and Playwright e2e run in CI's `stack` job
  against a throwaway Compose stack on the runner. Against QA, the `deployer` agent
  runs the smoke test after each deploy. After a PROD deploy, it runs a read-only check
  (health endpoint, login page loads, correct version) that creates no data.
  *(Target, not yet implemented: CI deploy jobs that run these checks themselves.)*
  Test tools are never deployed to QA or PROD.
- **Local runs are for feedback, CI decides.** Tests may run locally against
  a local stack while developing; a change counts as passing only when CI
  passes.
- **The test:** a fresh clone plus `podman compose up --build` in `deploy/` works
  with nothing installed but podman.
- **Docs follow the commands.** When a change you made alters a command, flag,
  env variable, service or script that people run (local, Compose, CI, QA, PROD),
  update every doc that mentions it before reporting the work as done: find them
  with `git grep`, fix the reference doc and docs/workflow.md. While still trying
  things out, skip it. Never edit legacy/ or generated files (`docs/openapi.json`,
  `frontend/src/api/schema.d.ts`, `frontend/src/lib/unaccent.generated.ts`:
  regenerate them instead).

## Host commands (for now)

Claude runs in a toolbox; podman is on the host (`flatpak-spawn --host podman ...`).

- **Claude may run on its own** podman commands for developing this project, from this
  repository: `podman compose` in `deploy/` (`up -d --build`, `down`, `ps`, `logs`, `exec`,
  `run`, `restart`, `build`), the dev PostgreSQL container from the README (start, stop,
  create), and inspecting these containers and images.
- **Ask first** for everything else, in particular: anything that deletes data
  (`down -v`, `volume rm`, `system prune`, removing the dev database), anything touching
  containers or images of other projects, system installs (`rpm-ostree`, `dnf`, `flatpak`),
  `sudo`, systemd units, and anything that reaches servers or registries (pushing images,
  `terraform apply`). For those, give the exact command; I want to follow what happens.
- This changes once the development-to-production chain is automated.
