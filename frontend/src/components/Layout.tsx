import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useMatch, useNavigate } from "react-router";

import { api } from "../api/client";
import { useLogout, useSession } from "../auth/session";

export function Layout() {
  const { data: session } = useSession();
  const logout = useLogout();
  const navigate = useNavigate();

  // The data page lives under /datasets/:id, so the default prefix match would
  // mark Datasets active there too; decide every tab explicitly.
  const datasetMatch = useMatch("/datasets/:datasetId/*");
  const onDataPage = useMatch("/datasets/:datasetId/data") !== null;
  const onDataIndex = useMatch("/data") !== null;
  const onRecordsPage = useMatch("/datasets/:datasetId/records") !== null;
  const onRecordsIndex = useMatch("/records") !== null;
  const onRecords = onRecordsPage || onRecordsIndex;
  const runId = useMatch("/runs/:runId")?.params.runId;
  const onExploreIndex = useMatch("/explore") !== null;
  const onLocal = useMatch("/local") !== null;
  const onExplore = runId !== undefined || onExploreIndex || onLocal;
  const dataActive = onDataPage || onDataIndex;
  const active = dataActive ? "data" : onExplore ? "explore" : onRecords ? "records" : "datasets";
  // In the explorer the dataset is the open network's (cached by its page).
  const run = useQuery({
    queryKey: ["run", Number(runId)],
    queryFn: () => api.getRun(Number(runId)),
    enabled: runId !== undefined,
  });
  const datasetId = datasetMatch?.params.datasetId ?? run.data?.dataset_id;
  const dataTarget = datasetId ? `/datasets/${datasetId}/data` : "/data";
  const exploreTarget = datasetId ? `/explore?dataset=${datasetId}` : "/explore";
  const recordsTarget = datasetId ? `/datasets/${datasetId}/records` : "/records";
  const tab = (name: typeof active) => ({
    className: active === name ? "active" : undefined,
    "aria-current": active === name ? ("page" as const) : undefined,
  });

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-title">
          <span className="app-title">Entity Networks</span>
          <div className="account">
            <span className="account-email">{session?.user.email}</span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={logout.isPending}
              onClick={() => logout.mutate(undefined, { onSettled: () => navigate("/login") })}
            >
              Log out
            </button>
          </div>
        </div>
        <nav className="topnav" aria-label="Main">
          <Link to="/datasets" {...tab("datasets")}>
            Datasets
          </Link>
          <Link to={dataTarget} {...tab("data")}>
            View data
          </Link>
          <Link to={exploreTarget} {...tab("explore")}>
            Explore
          </Link>
          <Link to={recordsTarget} {...tab("records")}>
            Records
          </Link>
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
