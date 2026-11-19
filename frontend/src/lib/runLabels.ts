// How runs are named in the UI. Custom runs take their labels from the dataset's
// network options (the backend catalog), so the names live in one place.
import { useQuery } from "@tanstack/react-query";

import { api, type NetworkOptions, type Run } from "../api/client";

export const RELATION_LABEL: Record<string, string> = {
  author: "Co-authorship",
  institution_keywords: "Institutions by shared keywords",
  custom: "Custom network",
};

export const networkOptionsKey = (datasetId: number) => ["network-options", datasetId] as const;

export function useNetworkOptions(datasetId: number | undefined) {
  return useQuery({
    queryKey: networkOptionsKey(datasetId ?? 0),
    queryFn: () => api.getNetworkOptions(datasetId!),
    enabled: datasetId !== undefined,
    staleTime: 60_000,
  });
}

const pct = (share: unknown) => `${Math.round(Number(share) * 100)}%`;

function labelOf(list: { key: string; label: string }[] | undefined, key: unknown): string {
  return list?.find((o) => o.key === key)?.label ?? String(key);
}

/** "Co-authorship", or for a custom run "Country linked by Keywords". */
export function runTitle(run: Pick<Run, "relation" | "params">, options?: NetworkOptions): string {
  if (run.relation !== "custom") return RELATION_LABEL[run.relation] ?? run.relation;
  const p = run.params as Record<string, unknown>;
  if (!options) return RELATION_LABEL.custom!;
  return `${labelOf(options.entities, p.entity)} linked by ${labelOf(options.links, p.link)}`;
}

/** One line with the parameters that shaped the network. */
export function describeParams(run: Run, options?: NetworkOptions): string {
  const p = run.params as Record<string, unknown>;
  const parts = [`up to ${p.top_n} nodes`];
  if (run.relation === "institution_keywords") {
    parts.push(`≥ ${p.min_shared_keywords} shared keywords`);
  }
  if (run.relation === "custom" && p.link !== "same_article") {
    parts.unshift(labelOf(options?.models, p.model));
    if (p.model === "word_matching") {
      parts.push(`≥ ${p.min_shared} shared · items in ≤ ${pct(p.max_item_df)} of articles`);
    } else {
      parts.push(`similarity ≥ ${pct(p.threshold)}`);
    }
  }
  if (run.relation === "custom" && Number(p.min_weight) > 1) {
    parts.push(`links ≥ ${p.min_weight} pairs`);
  }
  parts.push(`papers ≤ ${p.max_authors} authors`);
  return parts.join(" · ");
}
