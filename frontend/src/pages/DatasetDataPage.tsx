import { useQuery } from "@tanstack/react-query";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router";

import { api, type Dataset } from "../api/client";
import { GROUP_PALETTE } from "../lib/colors";
import { ErrorNote, Status, formatDate, formatNumber } from "../components/common";
import { DATASETS_KEY } from "./DatasetsPage";

// Shape of pipeline/profile.py's output (served as a free-form object).
interface Count {
  value: string;
  count: number;
}
interface ColumnInfo {
  name: string;
  type: string;
  non_empty: number;
  non_empty_pct: number;
  distinct: number;
  example: unknown;
}
interface KeywordStats {
  articles_with_pct: number;
  unique: number;
  top: Count[];
}
interface CatalogEntry {
  key: string;
  label: string;
  granularity: "fine" | "coarse";
  distinct: number;
  articles_with_pct: number;
  top: Count[];
}
interface LinkEntry {
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
interface Profile {
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

const KEY_COLUMNS = [
  "UT (Unique WOS ID)",
  "Article Title",
  "Author Full Names",
  "Publication Year",
  "Document Type",
  "Source Title",
  "Author Keywords",
];

export function DatasetDataPage() {
  const datasetId = Number(useParams().datasetId);
  const dataset = useQuery({
    queryKey: ["dataset", datasetId],
    queryFn: () => api.getDataset(datasetId),
  });
  const profile = useQuery({
    queryKey: ["profile", datasetId],
    queryFn: () => api.getProfile(datasetId),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 2000 : false),
  });

  return (
    <div className="page page-wide data-layout">
      <DatasetList currentId={datasetId} />
      <div className="data-content">
        <div className="page-header">
          <div>
            <Link to={`/datasets/${datasetId}`} className="back">
              ← {dataset.data?.name ?? "Dataset"}
            </Link>
            <h1>Data</h1>
            <p className="sub">What the uploaded files contain, before you build a network.</p>
          </div>
        </div>
        {profile.isPending && <p className="empty">Loading…</p>}
        {profile.isError && <ErrorNote error={profile.error} />}
        {profile.data?.status === "pending" && (
          <p className="empty">
            <Status status="pending" /> — this takes a few seconds after upload.
          </p>
        )}
        {profile.data?.status === "failed" && (
          <p className="error" role="alert">
            The files could not be analysed: {profile.data.error}
          </p>
        )}
        {profile.data?.status === "ready" && profile.data.profile && (
          <ProfileView profile={profile.data.profile as unknown as Profile} />
        )}
      </div>
    </div>
  );
}

const useDatasets = () => useQuery({ queryKey: DATASETS_KEY, queryFn: api.listDatasets });

const newestFirst = (a: Dataset, b: Dataset) => b.created_at.localeCompare(a.created_at);

/** "View data" without a dataset: open the newest one's data page. */
export function DataIndexPage() {
  const datasets = useDatasets();
  if (datasets.isPending) return <p className="empty">Loading…</p>;
  if (datasets.isError) {
    return (
      <div className="page">
        <ErrorNote error={datasets.error} />
      </div>
    );
  }
  const newest = [...datasets.data].sort(newestFirst)[0];
  if (newest) return <Navigate to={`/datasets/${newest.id}/data`} replace />;
  return (
    <div className="page">
      <h1>Data</h1>
      <p className="empty">
        No datasets yet. Upload one in <Link to="/datasets">Datasets</Link>.
      </p>
    </div>
  );
}

/** Every loaded dataset, to switch the data page between them. */
function DatasetList({ currentId }: { currentId: number }) {
  const datasets = useDatasets();
  return (
    <nav className="dataset-list" aria-label="Datasets">
      <h2 className="dataset-list-title">Datasets</h2>
      {datasets.isError && <ErrorNote error={datasets.error} />}
      <ul>
        {[...(datasets.data ?? [])].sort(newestFirst).map((d) => (
          <li key={d.id}>
            <Link
              to={`/datasets/${d.id}/data`}
              aria-current={d.id === currentId ? "page" : undefined}
            >
              <span className="dataset-list-name">{d.name}</span>
              <span className="dataset-list-date">
                {d.profile_status === "ready" ? (
                  formatDate(d.created_at)
                ) : (
                  <Status status={d.profile_status} />
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ProfileView({ profile }: { profile: Profile }) {
  const { stats } = profile;
  const years = stats.publication_years;
  const authors = stats.authors;
  const corr = stats.corresponding_author;
  const kw = stats.keywords ?? {};

  return (
    <>
      <section aria-label="Overview">
        <div className="tiles">
          <Tile label="Articles" value={formatNumber(stats.articles)} />
          {years?.min != null && (
            <Tile
              label="Publication years"
              value={years.min === years.max ? `${years.min}` : `${years.min}–${years.max}`}
            />
          )}
          {authors && (
            <Tile label="Distinct author names" value={formatNumber(authors.unique_names)} />
          )}
          {authors?.per_article && (
            <Tile label="Median authors per article" value={`${authors.per_article.median}`} />
          )}
          {stats.articles_with_orcid_pct != null && (
            <Tile label="Articles with ORCIDs" value={`${stats.articles_with_orcid_pct}%`} />
          )}
          {corr && <Tile label="Corresponding address parsed" value={`${corr.resolved_pct}%`} />}
        </div>
        {authors && authors.articles_over_mega_threshold > 0 && (
          <p className="small muted">
            {formatNumber(authors.articles_over_mega_threshold)} articles have more than{" "}
            {authors.mega_threshold} authors (up to {authors.per_article?.max}); networks ignore
            them by default.
          </p>
        )}
        {!!stats.duplicate_article_ids && (
          <p className="small error">
            {formatNumber(stats.duplicate_article_ids)} duplicate article IDs (the same record
            exported twice?).
          </p>
        )}
      </section>

      {!!stats.catalog?.length && (
        <Catalog nodes={stats.catalog} links={stats.link_catalog ?? []} />
      )}

      {years && years.per_year.length > 1 && (
        <section aria-labelledby="per-year">
          <h2 id="per-year">Articles per year</h2>
          <YearColumns perYear={years.per_year} />
        </section>
      )}

      <div className="grid-2">
        {stats.document_types && <BarList title="Document types" items={stats.document_types} />}
        {/* Older profiles without the link catalog: keyword lists here. */}
        {!stats.link_catalog && kw.author_keywords && (
          <BarList
            title="Author keywords"
            note={`${formatNumber(kw.author_keywords.unique)} distinct · on ${kw.author_keywords.articles_with_pct}% of articles`}
            items={kw.author_keywords.top}
          />
        )}
        {!stats.link_catalog && kw.keywords_plus && (
          <BarList
            title="Keywords Plus"
            note={`${formatNumber(kw.keywords_plus.unique)} distinct · on ${kw.keywords_plus.articles_with_pct}% of articles`}
            items={kw.keywords_plus.top}
          />
        )}
      </div>

      <SchemaTable schema={profile.schema} articles={stats.articles} />
      <SampleTable sample={profile.sample} />
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

const GROUPS = {
  fine: {
    title: "Nodes · fine-grained",
    short: "Fine-grained node",
    color: GROUP_PALETTE[0],
    help:
      "Thousands of distinct values; most links between them have weight 1, so a " +
      "minimum link weight of 2–3 thins the network a lot.",
  },
  coarse: {
    title: "Nodes · coarse",
    short: "Coarse node",
    color: GROUP_PALETTE[1],
    help:
      "About a hundred values shared by many articles; links weigh hundreds, so expect " +
      "a dense network and use the link weight filter in the Explorer.",
  },
  links: {
    title: "Linked by",
    short: "Link field",
    color: GROUP_PALETTE[2],
    help:
      "The article field compared to decide whether two nodes are connected. List fields " +
      "are matched item by item (word matching); text fields by similarity.",
  },
} as const;

const barsId = (title: string) => `bars-${title.replace(/\W+/g, "-").toLowerCase()}`;

function CatalogGroup({ group, children }: { group: keyof typeof GROUPS; children: ReactNode }) {
  const { title, color, help } = GROUPS[group];
  return (
    <section
      aria-labelledby={`catalog-${group}`}
      className="catalog-group"
      style={{ "--group-color": color } as CSSProperties}
    >
      <div className="catalog-group-head">
        <h3 id={`catalog-${group}`}>
          <span className="catalog-dot" aria-hidden="true" />
          {title}
        </h3>
        <p className="small muted">{help}</p>
      </div>
      {children}
    </section>
  );
}

/** What a custom network can be built from: every node type with its top values,
 *  grouped by granularity, and every field that can link them - to choose what to
 *  compare before building. */
function Catalog({ nodes, links }: { nodes: CatalogEntry[]; links: LinkEntry[] }) {
  const nodeLabel = new Map(nodes.map((n) => [n.key, n.label]));
  const listCards = links.filter((l) => l.kind === "list" && !l.same_as_node);
  const rows = links.filter((l) => !listCards.includes(l));
  return (
    <section aria-labelledby="catalog" className="catalog">
      <div>
        <h2 id="catalog">Catalog</h2>
        <p className="small muted">
          What a custom network can be built from: the nodes (what each dot is, with its top values
          in articles) and the fields that link them. Use it to choose what to compare.
        </p>
      </div>
      {(["fine", "coarse"] as const).map((g) => {
        const group = nodes.filter((e) => e.granularity === g);
        if (group.length === 0) return null;
        return (
          <CatalogGroup key={g} group={g}>
            <div className="grid-2">
              {group.map((e) => (
                <BarList
                  key={e.key}
                  level={4}
                  title={e.label}
                  note={`${GROUPS[g].short} · ${formatNumber(e.distinct)} distinct · on ${e.articles_with_pct}% of articles`}
                  items={e.top}
                />
              ))}
            </div>
          </CatalogGroup>
        );
      })}
      {links.length > 0 && (
        <CatalogGroup group="links">
          {listCards.length > 0 && (
            <div className="grid-2">
              {listCards.map((l) => (
                <BarList
                  key={l.key}
                  level={4}
                  title={l.label}
                  note={`${GROUPS.links.short} · ${formatNumber(l.distinct ?? 0)} distinct · on ${l.articles_with_pct}% of articles`}
                  items={l.top ?? []}
                />
              ))}
            </div>
          )}
          <div className="table-scroll">
            <table className="table link-table" aria-label="Other link fields">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Compared with</th>
                  <th scope="col" className="num">
                    On articles
                  </th>
                  <th scope="col">Contains</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.key}>
                    <th scope="row">{l.label}</th>
                    <td>{l.kind === "same_article" ? "Co-occurrence" : l.models.join(", ")}</td>
                    <td className="num">{l.articles_with_pct}%</td>
                    <td className="muted">
                      {l.kind === "same_article" && "Links nodes that appear on the same article"}
                      {l.kind === "list" && l.same_as_node && (
                        <>
                          {formatNumber(l.distinct ?? 0)} distinct · same values as{" "}
                          <a href={`#${barsId(nodeLabel.get(l.same_as_node) ?? "")}`}>
                            {nodeLabel.get(l.same_as_node) ?? l.same_as_node}
                          </a>
                        </>
                      )}
                      {l.kind === "string" &&
                        (l.median_words != null
                          ? `Text, typically ${formatNumber(l.median_words)} words`
                          : "Text")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CatalogGroup>
      )}
    </section>
  );
}

function BarList({
  title,
  items,
  note,
  level = 2,
}: {
  title: string;
  items: Count[];
  note?: string;
  level?: 2 | 4;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  const id = barsId(title);
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

function YearColumns({ perYear }: { perYear: Count[] }) {
  const max = Math.max(1, ...perYear.map((y) => y.count));
  const [active, setActive] = useState<Count | null>(null);
  const first = perYear[0]!;
  const last = perYear[perYear.length - 1]!;
  return (
    <div>
      <p className="small" aria-live="polite" style={{ minHeight: "1.5em", color: "var(--ink-2)" }}>
        {active
          ? `${active.value}: ${formatNumber(active.count)} articles`
          : "Hover a column for details"}
      </p>
      <div className="columns" onMouseLeave={() => setActive(null)}>
        {perYear.map((y) => (
          <span
            key={y.value}
            className="col"
            tabIndex={0}
            role="img"
            aria-label={`${y.value}: ${y.count} articles`}
            style={{ height: `${(100 * y.count) / max}%` }}
            onMouseEnter={() => setActive(y)}
            onFocus={() => setActive(y)}
            onBlur={() => setActive(null)}
          />
        ))}
      </div>
      <div className="columns-axis" aria-hidden="true">
        <span>{first.value}</span>
        <span>{last.value}</span>
      </div>
    </div>
  );
}

function SchemaTable({ schema, articles }: { schema: ColumnInfo[]; articles: number }) {
  return (
    <section aria-labelledby="schema-title">
      <div>
        <h2 id="schema-title">Columns</h2>
        <p className="small muted">
          {schema.length} columns in the export; filled = share of the {formatNumber(articles)}{" "}
          articles with a value.
        </p>
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
              <th className="num">Filled</th>
              <th className="num">Distinct</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            {schema.map((c) => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td className="muted">{c.type}</td>
                <td className="num">{c.non_empty_pct}%</td>
                <td className="num">{formatNumber(c.distinct)}</td>
                <td className="cell-clip muted" title={c.example == null ? "" : String(c.example)}>
                  {c.example == null ? "–" : String(c.example)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SampleTable({ sample }: { sample: Profile["sample"] }) {
  const [all, setAll] = useState(false);
  const keyIdx = KEY_COLUMNS.map((c) => sample.columns.indexOf(c)).filter((i) => i >= 0);
  const shown = all || keyIdx.length === 0 ? sample.columns.map((_, i) => i) : keyIdx;
  return (
    <section aria-labelledby="sample-title">
      <div className="section-head">
        <div>
          <h2 id="sample-title">Sample</h2>
          <p className="small muted">
            First {sample.rows.length} records ·{" "}
            {all ? `all ${sample.columns.length} columns` : `${shown.length} key columns`}
          </p>
        </div>
        {keyIdx.length > 0 && (
          <button type="button" className="btn btn-sm" onClick={() => setAll(!all)}>
            {all ? "Show key columns" : `Show all ${sample.columns.length} columns`}
          </button>
        )}
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              {shown.map((i) => (
                <th key={i}>{sample.columns[i]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.rows.map((row, r) => (
              <tr key={r}>
                {shown.map((i) => {
                  const v = row[i];
                  const text = v == null ? "" : String(v);
                  return (
                    <td key={i} className="cell-clip" title={text}>
                      {text || <span className="muted">–</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
