import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { api, type Relation, type Run, type RunCreate } from "../api/client";
import { ErrorNote, Status, formatBytes, formatDate, formatNumber } from "../components/common";
import { DATASETS_KEY } from "./DatasetsPage";

export const RELATION_LABEL: Record<string, string> = {
  author: "Co-authorship",
  institution_keywords: "Institutions by shared keywords",
};

const runsKey = (datasetId: number) => ["runs", datasetId] as const;

export function DatasetPage() {
  const datasetId = Number(useParams().datasetId);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const dataset = useQuery({
    queryKey: ["dataset", datasetId],
    queryFn: () => api.getDataset(datasetId),
    refetchInterval: (q) => (q.state.data?.profile_status === "pending" ? 2000 : false),
  });
  const runs = useQuery({
    queryKey: runsKey(datasetId),
    queryFn: () => api.listRuns(datasetId),
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === "queued" || r.status === "running") ? 2000 : false,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteDataset(datasetId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: DATASETS_KEY });
      navigate("/datasets");
    },
  });

  if (dataset.isPending) return <p className="empty">Loading…</p>;
  if (dataset.isError) {
    return (
      <div className="page">
        <ErrorNote error={dataset.error} />
        <Link to="/datasets">Back to datasets</Link>
      </div>
    );
  }
  const ds = dataset.data;
  const size = ds.files.reduce((s, f) => s + f.size_bytes, 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <Link to="/datasets" className="back">
            ← Datasets
          </Link>
          <h1>{ds.name}</h1>
          <p className="sub">
            {ds.files.length} file(s) · {formatBytes(size)} · uploaded {formatDate(ds.created_at)}
          </p>
        </div>
        <div className="form-row">
          <Link to={`/datasets/${ds.id}/data`} className="btn">
            View data
          </Link>
          <button
            type="button"
            className="btn btn-danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete “${ds.name}”, its files and all of its networks?`)) {
                remove.mutate();
              }
            }}
          >
            Delete dataset
          </button>
        </div>
      </div>
      {remove.isError && <ErrorNote error={remove.error} />}
      {ds.profile_status === "failed" && (
        <p className="error" role="alert">
          These files could not be analysed: {ds.profile_error}
        </p>
      )}

      <section aria-labelledby="networks-title">
        <div className="section-head">
          <h2 id="networks-title">Networks</h2>
        </div>
        <BuildNetworkForm datasetId={ds.id} />
        {runs.isError && <ErrorNote error={runs.error} />}
        {runs.data?.length === 0 && (
          <p className="empty">No networks yet. Build one above to explore it.</p>
        )}
        {!!runs.data?.length && <RunTable runs={runs.data} datasetId={ds.id} />}
      </section>
    </div>
  );
}

function RunTable({ runs, datasetId }: { runs: Run[]; datasetId: number }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: api.deleteRun,
    onSuccess: () => qc.invalidateQueries({ queryKey: runsKey(datasetId) }),
  });
  return (
    <>
      {remove.isError && <ErrorNote error={remove.error} />}
      <table className="table">
        <thead>
          <tr>
            <th>Network</th>
            <th className="num">Nodes</th>
            <th className="num">Edges</th>
            <th>Status</th>
            <th>Created</th>
            <th className="actions">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                {RELATION_LABEL[r.relation] ?? r.relation}
                <div className="muted small">{describeParams(r)}</div>
              </td>
              <td className="num">{r.node_count != null ? formatNumber(r.node_count) : "–"}</td>
              <td className="num">{r.edge_count != null ? formatNumber(r.edge_count) : "–"}</td>
              <td>
                <Status status={r.status} />
                {r.error && <div className="error">{r.error}</div>}
              </td>
              <td>{formatDate(r.created_at)}</td>
              <td className="actions">
                {r.status === "succeeded" && (
                  <>
                    <Link to={`/runs/${r.id}`} className="btn btn-sm btn-primary">
                      Explore
                    </Link>
                    <a href={api.exportUrl(r.id)} className="btn-link small" download>
                      Download
                    </a>
                  </>
                )}
                <button
                  type="button"
                  className="btn-link small btn-danger"
                  onClick={() => {
                    if (window.confirm("Delete this network?")) remove.mutate(r.id);
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function describeParams(run: Run): string {
  const p = run.params as Record<string, unknown>;
  const parts = [`up to ${p.top_n} nodes`];
  if (run.relation === "institution_keywords") {
    parts.push(`≥ ${p.min_shared_keywords} shared keywords`);
  }
  parts.push(`papers ≤ ${p.max_authors} authors`);
  return parts.join(" · ");
}

// Initial values mirror the API defaults (app/schemas/api.py).
const DEFAULT_TOP_N: Record<Relation, number> = { author: 700, institution_keywords: 150 };

function BuildNetworkForm({ datasetId }: { datasetId: number }) {
  const qc = useQueryClient();
  const [relation, setRelation] = useState<Relation>("author");
  const [topN, setTopN] = useState(DEFAULT_TOP_N.author);
  const [maxAuthors, setMaxAuthors] = useState(15);
  const [minShared, setMinShared] = useState(3);
  const [maxKeywordPct, setMaxKeywordPct] = useState(12);

  const create = useMutation({
    mutationFn: (body: RunCreate) => api.createRun(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: runsKey(datasetId) }),
  });

  const chooseRelation = (r: Relation) => {
    setRelation(r);
    setTopN(DEFAULT_TOP_N[r]);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const common = { top_n: topN, max_authors: maxAuthors };
    create.mutate(
      relation === "author"
        ? { dataset_id: datasetId, relation, params: common }
        : {
            dataset_id: datasetId,
            relation,
            params: {
              ...common,
              min_shared_keywords: minShared,
              max_keyword_df: maxKeywordPct / 100,
            },
          },
    );
  };

  return (
    <form className="panel-form" onSubmit={onSubmit} aria-label="Build network">
      <div className="form-row">
        <div className="field">
          <label htmlFor="relation">Relationship</label>
          <select
            id="relation"
            className="select"
            value={relation}
            onChange={(e) => chooseRelation(e.target.value as Relation)}
          >
            <option value="author">{RELATION_LABEL.author}</option>
            <option value="institution_keywords">{RELATION_LABEL.institution_keywords}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="top-n">Maximum nodes</label>
          <input
            id="top-n"
            className="input"
            type="number"
            min={10}
            max={2000}
            required
            value={topN}
            onChange={(e) => setTopN(Number(e.target.value))}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>
          {create.isPending ? "Queuing…" : "Build network"}
        </button>
      </div>
      <details>
        <summary>More options</summary>
        <div className="form-row" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="max-authors">Ignore papers with more authors than</label>
            <input
              id="max-authors"
              className="input"
              type="number"
              min={2}
              max={200}
              value={maxAuthors}
              onChange={(e) => setMaxAuthors(Number(e.target.value))}
            />
            <span className="hint">Large consensus papers otherwise dominate the network.</span>
          </div>
          {relation === "institution_keywords" && (
            <>
              <div className="field">
                <label htmlFor="min-shared">Minimum shared keywords</label>
                <input
                  id="min-shared"
                  className="input"
                  type="number"
                  min={1}
                  max={50}
                  value={minShared}
                  onChange={(e) => setMinShared(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="max-df">Ignore keywords used by more than (%)</label>
                <input
                  id="max-df"
                  className="input"
                  type="number"
                  min={1}
                  max={100}
                  value={maxKeywordPct}
                  onChange={(e) => setMaxKeywordPct(Number(e.target.value))}
                />
                <span className="hint">Very common keywords don’t indicate a real overlap.</span>
              </div>
            </>
          )}
        </div>
      </details>
      {create.isError && <ErrorNote error={create.error} />}
    </form>
  );
}
