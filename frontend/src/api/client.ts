// Thin typed client for the backend (types generated into ./schema.d.ts).
// Same-origin only: the session is an httpOnly cookie the browser sends itself;
// state-changing requests echo the CSRF token from the readable cookie.
import type { Network } from "../lib/network";
import type { components } from "./schema";

type S = components["schemas"];
export type User = S["UserOut"];
export type Session = S["SessionOut"];
export type Dataset = S["DatasetOut"];
export type DatasetProfileResponse = S["DatasetProfileOut"];
export type Run = S["RunOut"];
export type AuthorParams = S["AuthorParams"];
export type InstitutionKeywordParams = S["InstitutionKeywordParams"];
export type Relation = Run["relation"] & ("author" | "institution_keywords");
export type RunCreate =
  | { dataset_id: number; relation: "author"; params?: Partial<AuthorParams> }
  | {
      dataset_id: number;
      relation: "institution_keywords";
      params?: Partial<InstitutionKeywordParams>;
    };

const CSRF_COOKIE = "entitynet_csrf";
const CSRF_HEADER = "X-CSRF-Token";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function csrfToken(): string {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : "";
}

/** Human-readable message from a FastAPI error body ({detail: string | [{msg}]}). */
function errorMessage(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((d: { loc?: unknown[]; msg?: string }) => {
        const field = d.loc?.filter((p) => p !== "body").join(".");
        return field ? `${field}: ${d.msg}` : (d.msg ?? "Invalid input");
      })
      .join("; ");
  }
  return status >= 500 ? "Server error, please try again" : `Request failed (${status})`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") headers.set(CSRF_HEADER, csrfToken());
  if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");

  const res = await fetch(`/api${path}`, { ...init, method, headers, credentials: "same-origin" });
  if (res.status === 204) return undefined as T;
  const body = (res.headers.get("content-type") ?? "").includes("application/json")
    ? await res.json()
    : null;
  if (!res.ok) throw new ApiError(res.status, errorMessage(body, res.status));
  return body as T;
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  me: () => request<Session>("/auth/me"),
  login: (email: string, password: string) =>
    request<Session>("/auth/login", { method: "POST", body: json({ email, password }) }),
  register: (email: string, password: string) =>
    request<Session>("/auth/register", { method: "POST", body: json({ email, password }) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),

  listDatasets: () => request<Dataset[]>("/datasets"),
  getDataset: (id: number) => request<Dataset>(`/datasets/${id}`),
  getProfile: (id: number) => request<DatasetProfileResponse>(`/datasets/${id}/profile`),
  uploadDataset: (name: string, files: File[]) => {
    const form = new FormData();
    form.append("name", name);
    for (const f of files) form.append("files", f, f.name);
    return request<Dataset>("/datasets", { method: "POST", body: form });
  },
  deleteDataset: (id: number) => request<void>(`/datasets/${id}`, { method: "DELETE" }),

  listRuns: (datasetId: number) => request<Run[]>(`/runs?dataset_id=${datasetId}`),
  getRun: (id: number) => request<Run>(`/runs/${id}`),
  createRun: (body: RunCreate) => request<Run>("/runs", { method: "POST", body: json(body) }),
  deleteRun: (id: number) => request<void>(`/runs/${id}`, { method: "DELETE" }),
  getNetwork: (runId: number) => request<Network>(`/runs/${runId}/network`),
  exportUrl: (runId: number) => `/api/runs/${runId}/export`,
};
