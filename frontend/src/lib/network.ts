// Network JSON contract types (generated from the backend - see docs/openapi.json)
// plus small, pure helpers used across the explorer.
import type { components } from "../api/schema";

export type Network = components["schemas"]["Network"];
export type NetworkNode = components["schemas"]["NetworkNode"];
export type NetworkEdge = components["schemas"]["NetworkEdge"];
export type AttrValue = string | number | string[];
export type Attributed = { attr?: Record<string, AttrValue> | null };

export const TEAM_OTHER = "other";
export const TEAM_UNKNOWN = "unknown";

/** Distinct values in order of first appearance (stable legend / filter order). */
export function distinct<T>(values: Iterable<T>): T[] {
  return Array.from(new Set(values));
}

export function teamsOf(network: Network): string[] {
  return distinct(network.nodes.map((n) => n.team));
}

export function relationTypesOf(network: Network): string[] {
  return distinct(network.edges.map((e) => e.type));
}

export function prettyTeam(team: string): string {
  if (team === TEAM_OTHER) return "Other";
  if (team === TEAM_UNKNOWN) return "Unknown";
  return team.replace(/^cluster_/, "Group ");
}

export function prettyType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "Rossi, Anna" -> "Rossi" (graph labels); institution names are left whole. */
export function shortLabel(name: string): string {
  return String(name).split(",")[0] ?? name;
}

/** Sorted union of attribute keys across items. */
export function attrKeys(items: Attributed[]): string[] {
  const keys = new Set<string>();
  for (const item of items) if (item.attr) for (const k of Object.keys(item.attr)) keys.add(k);
  return Array.from(keys).sort();
}

/** Sorted distinct values of one attribute (list values are flattened). */
export function attrValues(items: Attributed[], key: string): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const v = item.attr?.[key];
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => seen.add(String(x)));
    else seen.add(String(v));
  }
  return Array.from(seen).sort();
}

/** Accepts unknown JSON (e.g. a local file) and checks the minimal contract shape. */
export function asNetwork(value: unknown): Network {
  const v = value as Partial<Network> | null;
  if (!v || !Array.isArray(v.nodes) || !Array.isArray(v.edges)) {
    throw new Error('Not a network JSON: expected "nodes" and "edges" arrays.');
  }
  const ids = new Set<string>();
  for (const n of v.nodes) {
    if (
      !n ||
      typeof n.id !== "string" ||
      typeof n.name !== "string" ||
      typeof n.team !== "string"
    ) {
      throw new Error('Every node needs string "id", "name" and "team".');
    }
    ids.add(n.id);
  }
  for (const e of v.edges) {
    if (!e || !ids.has(e.source) || !ids.has(e.target) || typeof e.type !== "string") {
      throw new Error('Every edge needs a "type" and must connect two existing nodes.');
    }
  }
  return v as Network;
}
