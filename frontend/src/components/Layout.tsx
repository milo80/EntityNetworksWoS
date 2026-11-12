import { NavLink, Outlet, useNavigate } from "react-router";

import { useLogout, useSession } from "../auth/session";

export function Layout() {
  const { data: session } = useSession();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/datasets" className="brand">
          EntityNetworks
        </NavLink>
        <nav className="topnav" aria-label="Main">
          <NavLink to="/datasets">Datasets</NavLink>
        </nav>
        <div className="account">
          <span>{session?.user.email}</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSettled: () => navigate("/login") })}
          >
            Log out
          </button>
        </div>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
