import { Link, Outlet, useMatch, useNavigate } from "react-router";

import { useLogout, useSession } from "../auth/session";

export function Layout() {
  const { data: session } = useSession();
  const logout = useLogout();
  const navigate = useNavigate();

  // The data page lives under /datasets/:id, so the default prefix match would
  // mark Datasets active there too; decide both tabs explicitly.
  const datasetMatch = useMatch("/datasets/:datasetId/*");
  const onDataPage = useMatch("/datasets/:datasetId/data") !== null;
  const onDataIndex = useMatch("/data") !== null;
  const dataActive = onDataPage || onDataIndex;
  const datasetId = datasetMatch?.params.datasetId;
  const dataTarget = datasetId ? `/datasets/${datasetId}/data` : "/data";

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
          <Link
            to="/datasets"
            className={dataActive ? undefined : "active"}
            aria-current={dataActive ? undefined : "page"}
          >
            Datasets
          </Link>
          <Link
            to={dataTarget}
            className={dataActive ? "active" : undefined}
            aria-current={dataActive ? "page" : undefined}
          >
            View data
          </Link>
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
