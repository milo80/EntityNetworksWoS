// A network opened from a local file (e.g. pipeline CLI output). Held in memory
// only - it is never uploaded - and lost on reload, like the prototype's file picker.
import { useSyncExternalStore } from "react";

import { asNetwork, type Network } from "./network";

export interface LocalNetwork {
  name: string;
  network: Network;
}

let current: LocalNetwork | null = null;
const listeners = new Set<() => void>();

export function setLocalNetwork(value: LocalNetwork | null) {
  current = value;
  listeners.forEach((l) => l());
}

export function useLocalNetwork(): LocalNetwork | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Parse and validate a user-chosen file; throws an Error with a readable message. */
export async function readNetworkFile(file: File): Promise<LocalNetwork> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error(`${file.name} is not valid JSON.`);
  }
  return { name: file.name, network: asNetwork(parsed) };
}
