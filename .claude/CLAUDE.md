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
  PROD without rebuilding. *(Target, not yet implemented: today
  `deploy/README.md` builds the images on the server.)*
- **Tests run in CI, not on servers.** Unit and integration tests run in CI jobs
  on throwaway runners. The smoke test and Playwright e2e run from CI against QA.
  *(Target, not yet implemented: no QA server yet; CI runs them against a
  throwaway Compose stack on the runner.)* Test tools are never deployed to QA
  or PROD.
- **The test:** a fresh clone plus `podman compose up --build` in `deploy/` works
  with nothing installed but podman.
