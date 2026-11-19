// The dataset profile's catalog (pipeline/profile.py): what a custom network can
// be built from. Shown on the data page and beside the build form.
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties, ReactNode } from "react";

import { api } from "../api/client";
import { GROUP_PALETTE } from "../lib/colors";
import { formatNumber } from "./common";

// Shape of pipeline/profile.py's output (served as a free-form object).
export interface Count {
  value: string;
  count: number;
}
export interface ColumnInfo {
  name: string;
  type: string;
  non_empty: number;
  non_empty_pct: number;
  distinct: number;
  example: unknown;
}
export interface KeywordStats {
  articles_with_pct: number;
  unique: number;
  top: Count[];
}
export interface CatalogEntry {
  key: string;
  label: string;
  granularity: "fine" | "coarse";
  distinct: number;
  articles_with_pct: number;
  top: Count[];
}
export interface LinkEntry {
  key: string;
  label: string;
  kind: "same_article" | "list" | "string";
  models: string[];
  articles_with_pct: number;
  distinct?: number;
  top?: Count[];
  same_as_node?: string | null;
  median_words?: number | null;
}
export interface Profile {
  schema: ColumnInfo[];
  sample: { columns: string[]; rows: unknown[][] };
  stats: {
    articles: number;
    columns: number;
    duplicate_article_ids?: number;
    publication_years?: { min: number | null; max: number | null; per_year: Count[] };
    document_types?: Count[];
    authors?: {
      unique_names: number;
      per_article: { median: number; max: number } | null;
      articles_over_mega_threshold: number;
      mega_threshold: number;
    };
    articles_with_orcid_pct?: number;
    keywords?: Record<string, KeywordStats>;
    corresponding_author?: { resolved_pct: number };
    catalog?: CatalogEntry[];
    link_catalog?: LinkEntry[];
  };
}

export const profileKey = (datasetId: number) => ["profile", datasetId] as const;

export function useProfile(datasetId: number) {
  return useQuery({
    queryKey: profileKey(datasetId),
    queryFn: () => api.getProfile(datasetId),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 2000 : false),
  });
}

/** The profile when it is ready, typed. */
export const readyProfile = (data: ReturnType<typeof useProfile>["data"]) =>
  data?.status === "ready" && data.profile ? (data.profile as unknown as Profile) : undefined;

export const GROUPS = {
  fine: {
    title: "Nodes · fine-grained",
    short: "Fine-grained node",
    option: "Fine-grained",
    color: GROUP_PALETTE[0],
    help:
      "Thousands of distinct values; most links between them have weight 1, so a " +
      "minimum link weight of 2–3 thins the network a lot.",
  },
  coarse: {
    title: "Nodes · coarse",
    short: "Coarse node",
    option: "Coarse",
    color: GROUP_PALETTE[1],
    help:
      "About a hundred values shared by many articles; links weigh hundreds, so expect " +
      "a dense network and use the link weight filter in the Explorer.",
  },
  links: {
    title: "Linked by",
    short: "Link field",
    option: "Link fields",
    color: GROUP_PALETTE[2],
    help:
      "The article field compared to decide whether two nodes are connected. List fields " +
      "are matched item by item (word matching); text fields by similarity.",
  },
} as const;
export type CatalogGroupName = keyof typeof GROUPS;

/** Style that sets --group-color for a catalog group (bars, dots, borders). */
export const groupStyle = (group: CatalogGroupName | undefined) =>
  (group ? { "--group-color": GROUPS[group].color } : {}) as CSSProperties;

export const barsId = (title: string) => `bars-${title.replace(/\W+/g, "-").toLowerCase()}`;

export const nodeNote = (e: CatalogEntry) =>
  `${GROUPS[e.granularity].short} · ${formatNumber(e.distinct)} distinct · on ${e.articles_with_pct}% of articles`;

export const linkNote = (l: LinkEntry) =>
  `${GROUPS.links.short} · ${formatNumber(l.distinct ?? 0)} distinct · on ${l.articles_with_pct}% of articles`;

/** What a link field without its own top values contains. */
export function linkContents(l: LinkEntry): string {
  if (l.kind === "same_article") return "Links nodes that appear on the same article";
  if (l.kind === "string") {
    return l.median_words != null
      ? `Text, typically ${formatNumber(l.median_words)} words`
      : "Text";
  }
  return `${formatNumber(l.distinct ?? 0)} distinct`;
}

export function BarList({
  title,
  items,
  note,
  level = 2,
  idPrefix = "",
}: {
  title: string;
  items: Count[];
  note?: ReactNode;
  level?: 2 | 4;
  /** Keeps heading ids unique when the same list shows twice on a page. */
  idPrefix?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  const id = idPrefix + barsId(title);
  const Heading = level === 2 ? "h2" : "h4";
  return (
    <section aria-labelledby={id}>
      <div>
        <Heading id={id}>{title}</Heading>
        {note && <p className="small muted">{note}</p>}
      </div>
      {items.length === 0 ? (
        <p className="small muted">No values.</p>
      ) : (
        <div className="bars" role="list">
          {items.map((item) => (
            <div key={item.value} role="listitem" style={{ display: "contents" }}>
              <span className="bar-label" title={item.value}>
                {item.value}
              </span>
              <span className="bar-track" aria-hidden="true">
                <span
                  className="bar"
                  style={{ display: "block", width: `${(100 * item.count) / max}%` }}
                />
              </span>
              <span className="bar-value">{formatNumber(item.count)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
