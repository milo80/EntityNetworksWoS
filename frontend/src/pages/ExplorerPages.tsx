import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";

import { api } from "../api/client";
import { ErrorNote } from "../components/common";
import { Explorer } from "../components/explorer/Explorer";
import { forgetNetwork, lastNetwork, rememberNetwork } from "../lib/lastNetwork";
import { useLocalNetwork } from "../lib/localNetwork";
import { runTitle, useNetworkOptions } from "../lib/runLabels";

export function RunExplorerPage() {
  const runId = Number(useParams().runId);
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId) });
  const network = useQuery({
    queryKey: ["network", runId],
    queryFn: () => api.getNetwork(runId),
    enabled: run.data?.status === "succeeded",
    staleTime: Infinity, // a finished network never changes
  });
  const dataset = useQuery({
    queryKey: ["dataset", run.data?.dataset_id],
    queryFn: () => api.getDataset(run.data!.dataset_id),
    enabled: !!run.data,
  });
  const options = useNetworkOptions(
    run.data?.relation === "custom" ? run.data.dataset_id : undefined,
  );
  // The Explore tab comes back here; a network that is gone is forgotten.
  const ready = run.data?.status === "succeeded" ? run.data : undefined;
  useEffect(() => {
    if (ready) rememberNetwork({ runId: ready.id, datasetId: ready.dataset_id });
  }, [ready]);
  useEffect(() => {
    if (run.isError && lastNetwork()?.runId === runId) forgetNetwork();
  }, [run.isError, runId]);

  if (run.isError) return <PageMessage error={run.error} />;
  if (run.data && run.data.status !== "succeeded") {
    return (
      <PageMessage
        text={`This network is ${run.data.status}.`}
        back={`/datasets/${run.data.dataset_id}`}
      />
    );
  }
  if (network.isError) return <PageMessage error={network.error} />;
  if (!network.data || !run.data) return <p className="empty">Loading network…</p>;

  const title = `${runTitle(run.data, options.data)}${
    dataset.data ? ` · ${dataset.data.name}` : ""
  }`;
  return (
    <Explorer
      network={network.data}
      title={title}
      back={
        <Link to={`/datasets/${run.data.dataset_id}`} className="back">
          ← {dataset.data?.name ?? "Dataset"}
        </Link>
      }
      footer={
        <a href={api.exportUrl(runId)} className="btn btn-sm" download>
          Download JSON
        </a>
      }
    />
  );
}

const newestFirst = (a: { created_at: string }, b: { created_at: string }) =>
  b.created_at.localeCompare(a.created_at);

/**
 * The "Explore" tab without a network in the URL: the network last opened (for
 * this dataset, when one is given), else the dataset's newest finished network.
 */
export function ExploreIndexPage() {
  const [params] = useSearchParams();
  const wanted = params.get("dataset") ? Number(params.get("dataset")) : undefined;
  const last = lastNetwork();
  const useLast = !!last && (wanted === undefined || last.datasetId === wanted);

  const datasets = useQuery({
    queryKey: ["datasets"],
    queryFn: api.listDatasets,
    enabled: !useLast && wanted === undefined,
  });
  const datasetId = wanted ?? [...(datasets.data ?? [])].sort(newestFirst)[0]?.id;
  const runs = useQuery({
    queryKey: ["runs", datasetId],
    queryFn: () => api.listRuns(datasetId!),
    enabled: !useLast && datasetId !== undefined,
  });

  if (useLast) return <Navigate to={`/runs/${last.runId}`} replace />;
  if (datasets.isError) return <PageMessage error={datasets.error} />;
  if (runs.isError) return <PageMessage error={runs.error} />;
  if (datasets.data && datasetId === undefined) {
    return <PageMessage text="No datasets yet: upload one, then build a network." />;
  }
  if (!runs.data) return <p className="empty">Loading…</p>;
  const newest = runs.data.filter((r) => r.status === "succeeded").sort(newestFirst)[0];
  if (newest) return <Navigate to={`/runs/${newest.id}`} replace />;
  return (
    <PageMessage
      text="No network built for this dataset yet."
      back={`/datasets/${datasetId}`}
      backLabel="Create one"
    />
  );
}

export function LocalExplorerPage() {
  const local = useLocalNetwork();
  if (!local) {
    return <PageMessage text="No local file is open (it isn’t kept after a reload)." />;
  }
  return (
    <Explorer
      key={local.name}
      network={local.network}
      title={local.name}
      actions={<span className="small muted">Local file · not uploaded</span>}
    />
  );
}

function PageMessage({
  text,
  error,
  back = "/datasets",
  backLabel = "Back",
}: {
  text?: string;
  error?: unknown;
  back?: string;
  backLabel?: string;
}) {
  return (
    <div className="page">
      {error ? <ErrorNote error={error} /> : <p>{text}</p>}
      <Link to={back}>{backLabel}</Link>
    </div>
  );
}
