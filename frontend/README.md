# Frontend

React 19 + TypeScript 5.9 + Vite, Cytoscape.js for the graph, TanStack Query
for API calls, React Router. Plain CSS with design tokens (`src/styles.css`).
Node 22.

## Commands

From `frontend/`:

    npm ci

| Command             |                                                                    |
| ------------------- | ------------------------------------------------------------------ |
| `npm run dev`       | Vite dev server on http://localhost:5173, proxies `/api` to :8000  |
| `npm test`          | Vitest (jsdom), once; `npm run test:watch` keeps it running        |
| `npm run lint`      | ESLint + Prettier check; `npm run format` rewrites with Prettier   |
| `npm run typecheck` | `tsc -b`                                                           |
| `npm run build`     | type-check, then build into `dist/` (served by Caddy in the image) |
| `npm run preview`   | serve `dist/` locally                                              |
| `npm run gen:api`   | regenerate `src/api/schema.d.ts` from `../docs/openapi.json`       |
| `npm run e2e`       | Playwright browser tests against a running system (below)          |

`npm run dev` needs the API on :8000 and a worker (see "Back-end" in the
[root README](../README.md#back-end-local-development)); set `API_TARGET` to
proxy elsewhere. CI runs `lint`, `typecheck`, `test`, `build`, checks that
`gen:api` changes nothing, and runs `npm audit --omit=dev`.

## Layout

| Path                       |                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `src/api/`                 | typed client (`client.ts`) + generated types (`schema.d.ts`, don't edit)                    |
| `src/lib/visibility.ts`    | filter rules - the single source of truth for graph, Readable and JSON                      |
| `src/lib/attrSearch.ts`    | attribute-search row editing                                                                |
| `src/lib/colors.ts`        | group colors (validated palette, see docs/design-notes.md)                                  |
| `src/components/explorer/` | Explorer: filters (incl. the link weight range), Cytoscape graph, details, resizable panels |
| `src/pages/`               | Login, password reset, Datasets, Dataset, Dataset data, Explorer pages                      |
| `src/test/`                | test setup and the fake backend (`mockApi.ts`)                                              |
| `e2e/`                     | Playwright browser tests (`playwright.config.ts`)                                           |

## Tests

Unit and component tests (`npm test`):

- `lib/*.test.ts` - filter logic.
- `components/explorer/Explorer.test.tsx`, `pages/pages.test.tsx` - user-event
  driven component and page tests against a fake backend (`src/test/mockApi.ts`).

Browser tests (`npm run e2e`, `e2e/`) drive a running system: by default the
Vite dev server on :5173 with the API and a worker, or the Compose stack with
`E2E_BASE_URL=https://localhost:8443` (see "Run it locally" in
[`deploy/README.md`](../deploy/README.md#run-it-locally-or-in-ci)). They need
registration open, or an existing account in `E2E_EMAIL` / `E2E_PASSWORD`. The
password reset test reads the emailed link from the API log: set
`E2E_API_LOGS_CMD` to a shell command that prints that log, or it is skipped.
The first time, download the browser with `npx playwright install chromium-headless-shell`.
