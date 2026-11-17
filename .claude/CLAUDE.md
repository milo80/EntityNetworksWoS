# EntityNetworks: project notes for Claude

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
  on throwaway runners. The smoke test and Playwright e2e run from CI against QA.
  *(Target, not yet implemented: CI runs them against a throwaway Compose stack
  on the runner, not yet against the QA server.)* *(Target, not yet implemented: no
  PROD deploy job yet.)* After a PROD deploy, CI runs a read-only smoke check
  against PROD (health endpoint, login page loads, correct version); it creates
  no data. Test tools are never deployed to QA or PROD.
- **Local runs are for feedback, CI decides.** Tests may run locally against
  a local stack while developing; a change counts as passing only when CI
  passes.
- **The test:** a fresh clone plus `podman compose up --build` in `deploy/` works
  with nothing installed but podman.

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
