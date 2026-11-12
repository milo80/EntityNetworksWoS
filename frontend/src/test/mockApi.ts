// A tiny fake backend for page tests: routes `fetch` calls to handlers and
// records every request (method, path, headers, body) for assertions.
//
// synthetic_profile.json is the real pipeline output for the synthetic WoS
// fixture; a backend test keeps it current. Regenerate from backend/ with:
//   .venv/bin/python -c "import json; from pipeline.profile import profile_dataset; \
//     from tests.fixtures.synthetic_wos import synthetic_wos_df; \
//     print(json.dumps(profile_dataset(synthetic_wos_df()), ensure_ascii=False, indent=1))" \
//     > ../frontend/src/test/synthetic_profile.json
import { vi } from "vitest";

export interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

type Handler = (req: Recorded) => { status?: number; body?: unknown } | undefined;

export function mockApi(routes: Record<string, Handler>) {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api/, "") + url.search;
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : ((init.body as unknown) ?? null);
    const req: Recorded = { method, path, headers: new Headers(init.headers), body };
    calls.push(req);
    const handler =
      routes[`${method} ${path}`] ?? routes[`${method} ${url.pathname.replace(/^\/api/, "")}`];
    const res = handler?.(req) ?? {
      status: 404,
      body: { detail: `No mock for ${method} ${path}` },
    };
    const status = res.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(res.body ?? null), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export const USER = {
  id: 1,
  email: "ann@example.org",
  role: "user",
  created_at: "2026-11-12T10:00:00Z",
};
export const SESSION = { user: USER, csrf_token: "csrf-from-session" };
