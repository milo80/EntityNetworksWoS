import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";

import { api } from "../api/client";
import { ErrorNote } from "../components/common";
import { Explorer } from "../components/explorer/Explorer";
import { useLocalNetwork } from "../lib/localNetwork";
import { RELATION_LABEL } from "./DatasetPage";

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

  const title = `${RELATION_LABEL[run.data.relation] ?? run.data.relation}${
    dataset.data ? ` · ${dataset.data.name}` : ""
  }`;
  return (
    <Explorer
      network={network.data}
      title={title}
      actions={
        <>
          <Link to={`/datasets/${run.data.dataset_id}`} className="btn btn-sm">
            Back to dataset
          </Link>
          <a href={api.exportUrl(runId)} className="btn btn-sm" download>
            Download JSON
          </a>
        </>
      }
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
}: {
  text?: string;
  error?: unknown;
  back?: string;
}) {
  return (
    <div className="page">
      {error ? <ErrorNote error={error} /> : <p>{text}</p>}
      <Link to={back}>Back</Link>
    </div>
  );
}
