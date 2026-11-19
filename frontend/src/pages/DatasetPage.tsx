import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";

import { api, type Run } from "../api/client";
import { ErrorNote, Status, formatBytes, formatDate, formatNumber } from "../components/common";
import { describeParams, runTitle, useNetworkOptions } from "../lib/runLabels";
import { BuildNetworkForm, runsKey } from "./BuildNetworkForm";
import { DATASETS_KEY } from "./DatasetsPage";

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
  const options = useNetworkOptions(
    runs.some((r) => r.relation === "custom") ? datasetId : undefined,
  );
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
                {runTitle(r, options.data)}
                <div className="muted small">{describeParams(r, options.data)}</div>
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
