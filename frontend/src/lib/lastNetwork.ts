// The network last opened in the explorer, so the "Explore" tab can return to
// it. A per-tab convenience: kept in memory and mirrored to sessionStorage so a
// reload keeps it; nothing is shared.

export interface LastNetwork {
  runId: number;
  datasetId: number;
}

const KEY = "entitynet:last-network";
let memory: LastNetwork | null = null;

export function rememberNetwork(last: LastNetwork): void {
  memory = last;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(last));
  } catch {
    // Storage blocked: the in-memory copy still covers navigation.
  }
}

export function lastNetwork(): LastNetwork | null {
  if (memory) return memory;
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    const o = v as Partial<LastNetwork> | null;
    if (o && typeof o.runId === "number" && typeof o.datasetId === "number") {
      memory = { runId: o.runId, datasetId: o.datasetId };
    }
  } catch {
    // Unreadable or blocked: no remembered network.
  }
  return memory;
}

export function forgetNetwork(): void {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
