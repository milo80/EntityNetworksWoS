# Frontend

React 19 + TypeScript 5.9 + Vite, Cytoscape.js for the graph, TanStack Query
for API calls, React Router. Plain CSS with design tokens (`src/styles.css`).

    npm install
    npm run dev          # http://localhost:5173, proxies /api to http://127.0.0.1:8000
    npm test             # Vitest (jsdom)
    npm run lint         # ESLint + Prettier check
    npm run typecheck
    npm run build        # -> dist/ (served by Caddy in production)
    npm run gen:api      # regenerate src/api/schema.d.ts from ../docs/openapi.json

The API must run on :8000 for `npm run dev` (see the root README); set
`API_TARGET` to proxy elsewhere.

## Layout

| Path                       |                                                                          |
| -------------------------- | ------------------------------------------------------------------------ |
| `src/api/`                 | typed client (`client.ts`) + generated types (`schema.d.ts`, don't edit) |
| `src/lib/visibility.ts`    | filter rules - the single source of truth for graph, Readable and JSON   |
| `src/lib/attrSearch.ts`    | attribute-search row editing                                             |
| `src/lib/colors.ts`        | group colors (validated palette, see docs/design-notes.md)               |
| `src/components/explorer/` | Explorer: filters, Cytoscape graph, details, resizable panels            |
| `src/pages/`               | Login, Datasets, Dataset, Dataset data, Explorer pages                   |

## Tests

- `lib/*.test.ts` - filter logic.
- `lib/visibility.parity.test.ts` - loads `legacy/graph_network_prototype2.html`
  in jsdom, drives it with DOM events and checks the port shows exactly the
  same nodes/edges on the golden networks.
- `components/explorer/Explorer.test.tsx`, `pages/pages.test.tsx` - user-event
  driven component and page tests against a fake backend (`src/test/mockApi.ts`).
