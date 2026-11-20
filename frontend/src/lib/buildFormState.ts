// The Build network panel's state per dataset, kept while you look elsewhere
// (View data, an explorer) and come back. A per-tab convenience: kept in memory
// and mirrored to sessionStorage so a reload keeps it; nothing is shared.
import type { Relation } from "../api/client";

export interface BuildFormState {
  relation: Relation | null;
  values: Record<string, string>;
  /** attributes: node attributes for attribute search (missing in older saved state). */
  custom: { entity: string; link: string; model: string; attributes?: string[] };
  expanded: boolean;
  moreOpen: boolean;
}

const memory = new Map<number, BuildFormState>();
const storageKey = (datasetId: number) => `entitynet:build-form:${datasetId}`;

function isState(x: unknown): x is BuildFormState {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  const custom = s.custom as Record<string, unknown> | null;
  return (
    (s.relation === null || typeof s.relation === "string") &&
    typeof s.values === "object" &&
    s.values !== null &&
    typeof custom === "object" &&
    custom !== null &&
    typeof custom.entity === "string" &&
    typeof custom.link === "string" &&
    typeof custom.model === "string" &&
    (custom.attributes === undefined || Array.isArray(custom.attributes)) &&
    typeof s.expanded === "boolean" &&
    typeof s.moreOpen === "boolean"
  );
}

export function loadFormState(datasetId: number): BuildFormState | null {
  const kept = memory.get(datasetId);
  if (kept) return kept;
  try {
    const raw = sessionStorage.getItem(storageKey(datasetId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveFormState(datasetId: number, state: BuildFormState): void {
  memory.set(datasetId, state);
  try {
    sessionStorage.setItem(storageKey(datasetId), JSON.stringify(state));
  } catch {
    // Storage blocked or full: the in-memory copy still covers navigation.
  }
}

export function clearFormState(datasetId?: number): void {
  const ids = datasetId === undefined ? [...memory.keys()] : [datasetId];
  if (datasetId === undefined) memory.clear();
  else memory.delete(datasetId);
  try {
    if (datasetId === undefined) {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith("entitynet:build-form:")) sessionStorage.removeItem(key);
      }
    } else {
      for (const id of ids) sessionStorage.removeItem(storageKey(id));
    }
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
