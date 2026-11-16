---
name: api-change
description: After changing the backend API (routes, request/response models, status codes, auth in backend/app/api/ or its schemas), regenerate docs/openapi.json and frontend/src/api/schema.d.ts and run the same checks CI runs to confirm they match. Use it before reporting an API change as done; the regeneration is easy to forget and CI fails on it.
---

# Regenerate the API contract after an API change

`docs/openapi.json` is generated from the FastAPI app, and the frontend's
TypeScript types (`frontend/src/api/schema.d.ts`) are generated from it. Both are
committed, and CI fails when either is stale:

- backend job: `backend/tests/test_schema.py::test_committed_openapi_is_up_to_date`
- frontend job: "Generated API types match docs/openapi.json"
  (`npm run gen:api && git diff --exit-code src/api/schema.d.ts`)

## Steps

Run from the repository root.

1. Regenerate the OpenAPI document:
   ```bash
   cd backend && .venv/bin/python -m app.openapi_export
   ```
2. Regenerate the TypeScript types:
   ```bash
   cd frontend && npm run gen:api
   ```
3. Run the checks CI runs (CI compares against the commit; before committing,
   compare against a fresh generation instead):
   ```bash
   cd backend && .venv/bin/python -m pytest -q tests/test_schema.py -k openapi
   cd frontend && npx openapi-typescript ../docs/openapi.json -o /tmp/schema.check.d.ts \
     && cmp src/api/schema.d.ts /tmp/schema.check.d.ts && rm /tmp/schema.check.d.ts
   cd frontend && npm run typecheck
   ```
   The pytest check and `cmp` must pass. `npm run typecheck` shows the frontend
   code that no longer fits the new API; fix it.
4. Report which of `docs/openapi.json` and `src/api/schema.d.ts` changed, and
   include both in the same commit as the API change.

## Rules
- Never edit `docs/openapi.json` or `src/api/schema.d.ts` by hand; they are
  regenerated. (Editing them with Edit/Write would also trigger the format hook
  and make them differ from the generator's output.)
- No new dependencies: both generators are already pinned in the project
  (`backend/constraints.txt`, `frontend/package-lock.json`).
- If `backend/.venv` or `frontend/node_modules` is missing, say so; don't
  install globally.
