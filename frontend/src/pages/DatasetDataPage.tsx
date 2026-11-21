import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router";

import { api, type Dataset } from "../api/client";
import {
  BarList,
  GROUPS,
  barsId,
  groupStyle,
  linkContents,
  linkNote,
  nodeNote,
  readyProfile,
  useProfile,
  type CatalogEntry,
  type CatalogGroupName,
  type ColumnInfo,
  type Count,
  type LinkEntry,
  type Profile,
} from "../components/catalog";
import { ErrorNote, Status, formatDate, formatNumber } from "../components/common";
import { KEY_COLUMNS } from "../lib/records";
import { DATASETS_KEY } from "./DatasetsPage";

/** The data page shows the top 10 of each catalog list (the build form 20). */
const DATA_TOP = 10;

export function DatasetDataPage() {
  const datasetId = Number(useParams().datasetId);
  const dataset = useQuery({
    queryKey: ["dataset", datasetId],
    queryFn: () => api.getDataset(datasetId),
  });
  const profile = useProfile(datasetId);
  const ready = readyProfile(profile.data);

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
        {ready && <ProfileView profile={ready} />}
      </div>
    </div>
  );
}

export const useDatasets = () => useQuery({ queryKey: DATASETS_KEY, queryFn: api.listDatasets });

export const newestFirst = (a: Dataset, b: Dataset) => b.created_at.localeCompare(a.created_at);

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

/** Every loaded dataset, to switch the data (or records) page between them. */
export function DatasetList({
  currentId,
  page = "data",
}: {
  currentId: number;
  page?: "data" | "records";
}) {
  const datasets = useDatasets();
  return (
    <nav className="dataset-list" aria-label="Datasets">
      <h2 className="dataset-list-title">Datasets</h2>
      {datasets.isError && <ErrorNote error={datasets.error} />}
      <ul>
        {[...(datasets.data ?? [])].sort(newestFirst).map((d) => (
          <li key={d.id}>
            <Link
              to={`/datasets/${d.id}/${page}`}
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

function CatalogGroup({ group, children }: { group: CatalogGroupName; children: ReactNode }) {
  const { title, help } = GROUPS[group];
  return (
    <section
      aria-labelledby={`catalog-${group}`}
      className="catalog-group"
      style={groupStyle(group)}
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
                  note={nodeNote(e)}
                  items={e.top.slice(0, DATA_TOP)}
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
                  note={linkNote(l)}
                  items={(l.top ?? []).slice(0, DATA_TOP)}
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
                      {l.kind !== "list" && linkContents(l)}
                      {l.kind === "list" && l.same_as_node && (
                        <>
                          {formatNumber(l.distinct ?? 0)} distinct · same values as{" "}
                          <a href={`#${barsId(nodeLabel.get(l.same_as_node) ?? "")}`}>
                            {nodeLabel.get(l.same_as_node) ?? l.same_as_node}
                          </a>
                        </>
                      )}
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
