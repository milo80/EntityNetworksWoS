// The Records tab's state outside React: default columns, the per-dataset column
// choice, the URL form of the view, and the highlights of matched text. The
// server filters (backend/app/services/records.py); these rules mirror it so the
// highlights show what matched.
import type { RecordFilter, RecordOperator } from "../api/client";
import { UNACCENT } from "./unaccent.generated";

export const PAGE_SIZE = 50;
export const INSTITUTIONS_PARSED = "Institutions (parsed)";
export const KEYWORDS_NORMALIZED = "Keywords (normalized)";
export const DERIVED_NOTE = "derived, not in the export";

/** The data page's key columns (its sample table shows these). */
export const KEY_COLUMNS = [
  "UT (Unique WOS ID)",
  "Article Title",
  "Author Full Names",
  "Publication Year",
  "Document Type",
  "Source Title",
  "Author Keywords",
];

/** What the Records table shows by default, in this order, when the export has it. */
export const DEFAULT_RECORD_COLUMNS = [...KEY_COLUMNS, "Keywords Plus", INSTITUTIONS_PARSED];

/** Columns whose items "has item" normalizes as the keyword networks do. */
const KEYWORD_COLUMNS = new Set(["Author Keywords", "Keywords Plus", KEYWORDS_NORMALIZED]);

export const OPERATORS: { op: RecordOperator; label: string }[] = [
  { op: "contains", label: "contains" },
  { op: "not_contains", label: "does not contain" },
  { op: "has_item", label: "has item" },
  { op: "is_empty", label: "is empty" },
  { op: "not_empty", label: "is not empty" },
];
export const takesValue = (op: RecordOperator) => op !== "is_empty" && op !== "not_empty";

export function defaultColumns(available: readonly string[]): string[] {
  const chosen = DEFAULT_RECORD_COLUMNS.filter((c) => available.includes(c));
  return chosen.length ? chosen : available.slice(0, 6);
}

/** Visible columns in display order: the default set's order first, then the export's. */
export function orderColumns(visible: readonly string[], available: readonly string[]): string[] {
  const shown = new Set(visible);
  const first = DEFAULT_RECORD_COLUMNS.filter((c) => shown.has(c) && available.includes(c));
  return [...first, ...available.filter((c) => shown.has(c) && !first.includes(c))];
}

// ------------------------------------------------------------ column choice
// Remembered per dataset in this browser (localStorage), unlike the per-tab
// build form state.

const columnsKey = (datasetId: number) => `entitynet:records-columns:${datasetId}`;

export function storedColumns(datasetId: number): string[] | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(columnsKey(datasetId)) ?? "null");
    return Array.isArray(v) && v.every((c) => typeof c === "string") ? v : null;
  } catch {
    return null;
  }
}

export function storeColumns(datasetId: number, columns: readonly string[] | null) {
  try {
    if (columns === null) localStorage.removeItem(columnsKey(datasetId));
    else localStorage.setItem(columnsKey(datasetId), JSON.stringify(columns));
  } catch {
    // Storage full or disabled: the choice just isn't remembered.
  }
}

// ------------------------------------------------------------ URL

export type RecordsOrigin = "node" | "link";

export interface RecordsView {
  page: number;
  filters: RecordFilter[];
  sort?: string;
  order?: "asc" | "desc";
  /** Opened from the explorer ("Show records"). */
  from?: RecordsOrigin;
}

/** Each filter is one `f` parameter: a JSON [column, op, value]. */
export function viewFromParams(params: URLSearchParams): RecordsView {
  const filters: RecordFilter[] = [];
  for (const raw of params.getAll("f")) {
    try {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v) && typeof v[0] === "string" && OPERATORS.some((o) => o.op === v[1])) {
        filters.push({ column: v[0], op: v[1] as RecordOperator, value: String(v[2] ?? "") });
      }
    } catch {
      // A hand-edited, broken parameter: ignored.
    }
  }
  const page = Math.max(1, Math.floor(Number(params.get("page"))) || 1);
  const sort = params.get("sort") || undefined;
  const order = params.get("order") === "desc" ? "desc" : "asc";
  const from = params.get("from");
  return {
    page,
    filters,
    sort,
    order: sort ? order : undefined,
    from: from === "node" || from === "link" ? from : undefined,
  };
}

export function viewToParams(view: RecordsView): URLSearchParams {
  const params = new URLSearchParams();
  for (const f of view.filters) params.append("f", JSON.stringify([f.column, f.op, f.value]));
  if (view.sort) {
    params.set("sort", view.sort);
    params.set("order", view.order ?? "asc");
  }
  if (view.page > 1) params.set("page", String(view.page));
  if (view.from) params.set("from", view.from);
  return params;
}

export function recordsUrl(datasetId: number, view: Partial<RecordsView> = {}): string {
  const params = viewToParams({ page: 1, filters: [], ...view });
  const qs = params.toString();
  return `/datasets/${datasetId}/records${qs ? `?${qs}` : ""}`;
}

/** Header click: ascending, then descending, then back to upload order. */
export function nextSort(
  view: Pick<RecordsView, "sort" | "order">,
  column: string,
): Pick<RecordsView, "sort" | "order"> {
  if (view.sort !== column) return { sort: column, order: "asc" };
  if (view.order !== "desc") return { sort: column, order: "desc" };
  return { sort: undefined, order: undefined };
}

// ------------------------------------------------------------ highlights

/**
 * "a; B ;; c" -> ["a", "B", "c"]: the explorer's attribute-search terms, not
 * lower-cased yet: they are folded as the server folds them (unaccent, then lower).
 */
export const filterTerms = (value: string): string[] =>
  value
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

/**
 * Case and accents folded away ("İ", "Í", "ì" -> "i") exactly as the server's fold,
 * lower(unaccent(...)) in backend/app/services/records.py: each character through
 * PostgreSQL's unaccent table (generated from it), then lower-cased. A character
 * unaccent leaves alone is left alone here too.
 */
function fold(s: string): string {
  // Per character, as PostgreSQL's lower(): a final "Σ" gives "σ", not "ς".
  let out = "";
  for (const c of s) out += (UNACCENT[c] ?? c).toLowerCase();
  return out;
}

/** As the server's fold on keyword columns: hyphens (typographic dashes too) as spaces. */
const normalizeKeyword = (s: string) => fold(s.trim()).replace(/-/g, " ");

export interface Segment {
  text: string;
  mark: boolean;
}

function markRanges(text: string, ranges: [number, number][]): Segment[] {
  if (!ranges.length) return [{ text, mark: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    if (from > at) out.push({ text: text.slice(at, from), mark: false });
    out.push({ text: text.slice(from, end), mark: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

/**
 * The folded text, and for each of its characters the start and end of the original
 * character it came from: folding can change the length ("İ" -> "i", "ß" -> "ss"),
 * so indices found in the folded text are mapped back before cutting the original.
 * A character and the combining marks after it fold together, so a highlight never
 * separates a letter from its accent.
 */
function foldWithOrigin(text: string): { folded: string; start: number[]; end: number[] } {
  let folded = "";
  const start: number[] = [];
  const end: number[] = [];
  for (const m of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const f = fold(m[0]);
    folded += f;
    for (let k = 0; k < f.length; k++) {
      start.push(m.index);
      end.push(m.index + m[0].length);
    }
  }
  return { folded, start, end };
}

/** The parts of a cell that a "contains" or "has item" filter on its column matched. */
export function highlight(text: string, column: string, filters: readonly RecordFilter[]) {
  const ranges: [number, number][] = [];
  const keyword = KEYWORD_COLUMNS.has(column);
  const { folded, start, end } = foldWithOrigin(text);
  // Keyword columns: hyphens count as spaces, as on the server (same length, same indices).
  const cell = keyword ? folded.replace(/-/g, " ") : folded;
  // Case and accents are ignored on both sides, as on the server.
  const norm = (s: string) => (keyword ? normalizeKeyword(s) : fold(s.trim()));
  for (const f of filters) {
    if (f.column !== column) continue;
    const terms = filterTerms(f.value);
    if (f.op === "contains") {
      for (const t of new Set(terms.map(norm))) {
        if (!t) continue;
        for (let i = cell.indexOf(t); i >= 0; i = cell.indexOf(t, i + t.length)) {
          ranges.push([start[i]!, end[i + t.length - 1]!]);
        }
      }
    } else if (f.op === "has_item") {
      const wanted = new Set(terms.map(norm));
      let at = 0;
      for (const part of text.split(";")) {
        const lead = part.length - part.trimStart().length;
        const item = part.trim();
        if (item && wanted.has(norm(item))) ranges.push([at + lead, at + lead + item.length]);
        at += part.length + 1;
      }
    }
  }
  return markRanges(text, ranges);
}

// ------------------------------------------------------------ from the explorer

/** The network a selection comes from: its dataset, node type and link field. */
export interface RecordsSource {
  datasetId: number;
  /** A custom.ENTITIES key ("institution", ...); undefined when it maps to none. */
  entity?: string;
  /** A custom.LINKS key ("keywords", ...). */
  link?: string;
}

/** Node type -> the records column holding its values (REQ-REC-5). */
export const NODE_COLUMNS: Record<string, string> = {
  author: "Author Full Names",
  institution: INSTITUTIONS_PARSED,
  journal: "Source Title",
  organization: "Affiliations",
  funder: "Funding Orgs",
  wos_category: "WoS Categories",
  research_area: "Research Areas",
  article: "UT (Unique WOS ID)",
};

/** Keyword link field -> the records column its shared items come from. */
export const LINK_COLUMNS: Record<string, string> = {
  keywords: KEYWORDS_NORMALIZED,
  author_keywords: "Author Keywords",
  keywords_plus: "Keywords Plus",
};

interface Named {
  id: string;
  name: string;
}

/** What a node is called in its records column: an article node's is its UT (its id). */
const recordValue = (source: RecordsSource, node: Named) =>
  source.entity === "article" ? node.id : node.name;

export function nodeRecordsUrl(source: RecordsSource, node: Named): string | null {
  const column = source.entity && NODE_COLUMNS[source.entity];
  if (!column) return null;
  return recordsUrl(source.datasetId, {
    filters: [{ column, op: "contains", value: recordValue(source, node) }],
    from: "node",
  });
}

export function linkRecordsUrl(
  source: RecordsSource,
  a: Named,
  b: Named,
  shared: readonly string[],
): string | null {
  const column = source.entity && NODE_COLUMNS[source.entity];
  const keywordColumn = source.link && LINK_COLUMNS[source.link];
  if (!column || !keywordColumn) return null;
  const filters: RecordFilter[] = [
    { column, op: "contains", value: `${recordValue(source, a)}; ${recordValue(source, b)}` },
  ];
  if (shared.length)
    filters.push({ column: keywordColumn, op: "contains", value: shared.join("; ") });
  return recordsUrl(source.datasetId, { filters, from: "link" });
}
