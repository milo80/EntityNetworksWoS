import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";

import { api } from "../api/client";
import { ErrorNote, Status, formatNumber } from "../components/common";

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
    corresponding_author?: {
      resolved_pct: number;
      top_countries: Count[];
      top_institutions: Count[];
    };
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
    <div className="page">
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

      {years && years.per_year.length > 1 && (
        <section aria-labelledby="per-year">
          <h2 id="per-year">Articles per year</h2>
          <YearColumns perYear={years.per_year} />
        </section>
      )}

      <div className="grid-2">
        {stats.document_types && <BarList title="Document types" items={stats.document_types} />}
        {corr && <BarList title="Countries (corresponding author)" items={corr.top_countries} />}
        {corr && (
          <BarList title="Institutions (corresponding author)" items={corr.top_institutions} />
        )}
        {kw.author_keywords && (
          <BarList
            title="Author keywords"
            note={`${formatNumber(kw.author_keywords.unique)} distinct · on ${kw.author_keywords.articles_with_pct}% of articles`}
            items={kw.author_keywords.top}
          />
        )}
        {kw.keywords_plus && (
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

function BarList({ title, items, note }: { title: string; items: Count[]; note?: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  const id = `bars-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section aria-labelledby={id}>
      <div>
        <h2 id={id}>{title}</h2>
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
