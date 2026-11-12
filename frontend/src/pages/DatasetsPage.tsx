import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";

import { api, type Dataset } from "../api/client";
import { ErrorNote, Status, formatBytes, formatDate } from "../components/common";
import { readNetworkFile, setLocalNetwork } from "../lib/localNetwork";

export const DATASETS_KEY = ["datasets"] as const;

export function DatasetsPage() {
  const navigate = useNavigate();
  const [uploading, setUploading] = useState(false);
  const datasets = useQuery({
    queryKey: DATASETS_KEY,
    queryFn: api.listDatasets,
    // Keep polling while any dataset is still being analysed.
    refetchInterval: (q) =>
      q.state.data?.some((d) => d.profile_status === "pending") ? 2000 : false,
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Datasets</h1>
          <p className="sub">Web of Science exports you have uploaded.</p>
        </div>
        {!uploading && (
          <button type="button" className="btn btn-primary" onClick={() => setUploading(true)}>
            Upload dataset
          </button>
        )}
      </div>

      {uploading && (
        <UploadForm
          onDone={(ds) => {
            setUploading(false);
            if (ds) navigate(`/datasets/${ds.id}`);
          }}
        />
      )}

      <section aria-label="Your datasets">
        {datasets.isPending && <p className="empty">Loading…</p>}
        {datasets.isError && <ErrorNote error={datasets.error} />}
        {datasets.data?.length === 0 && !uploading && (
          <p className="empty">
            No datasets yet. Upload the .xls files you exported from Web of Science.
          </p>
        )}
        {!!datasets.data?.length && <DatasetTable datasets={datasets.data} />}
      </section>

      <OpenLocalFile />
    </div>
  );
}

function DatasetTable({ datasets }: { datasets: Dataset[] }) {
  const navigate = useNavigate();
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th className="num">Files</th>
          <th className="num">Size</th>
          <th>Uploaded</th>
          <th>Data</th>
        </tr>
      </thead>
      <tbody>
        {datasets.map((d) => (
          <tr key={d.id} className="clickable" onClick={() => navigate(`/datasets/${d.id}`)}>
            <td>
              <Link to={`/datasets/${d.id}`} onClick={(e) => e.stopPropagation()}>
                {d.name}
              </Link>
            </td>
            <td className="num">{d.files.length}</td>
            <td className="num">{formatBytes(d.files.reduce((s, f) => s + f.size_bytes, 0))}</td>
            <td>{formatDate(d.created_at)}</td>
            <td>
              <Status status={d.profile_status} title={d.profile_error} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UploadForm({ onDone }: { onDone: (dataset: Dataset | null) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const upload = useMutation({
    mutationFn: () => api.uploadDataset(name.trim(), files),
    onSuccess: (ds) => {
      qc.invalidateQueries({ queryKey: DATASETS_KEY });
      onDone(ds);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    upload.mutate();
  };

  return (
    <form className="panel-form" onSubmit={onSubmit} aria-label="Upload dataset">
      <h2>Upload dataset</h2>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ds-name">Name</label>
          <input
            id="ds-name"
            className="input"
            required
            maxLength={200}
            value={name}
            placeholder="e.g. AI in medicine 2020–2026"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ds-files">WoS export files (.xls)</label>
          <input
            id="ds-files"
            type="file"
            accept=".xls,application/vnd.ms-excel"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          <span className="hint">
            {files.length
              ? `${files.length} file(s), ${formatBytes(files.reduce((s, f) => s + f.size, 0))}`
              : "Up to 10 files, 50 MB each."}
          </span>
        </div>
      </div>
      {upload.isError && <ErrorNote error={upload.error} />}
      <div className="form-row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={upload.isPending || !files.length || !name.trim()}
        >
          {upload.isPending ? "Uploading…" : "Upload"}
        </button>
        <button type="button" className="btn" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function OpenLocalFile() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <p className="small muted">
      Have a network JSON file, e.g. from the pipeline command line?{" "}
      <button type="button" className="btn-link" onClick={() => input.current?.click()}>
        Open local file…
      </button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        hidden
        aria-label="Network JSON file"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            setLocalNetwork(await readNetworkFile(file));
            setError(null);
            navigate("/local");
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      {error && (
        <span className="error" role="alert" style={{ display: "block", marginTop: 4 }}>
          {error}
        </span>
      )}
    </p>
  );
}
