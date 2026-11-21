import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";

import { RequireAuth } from "./auth/session";
import { Layout } from "./components/Layout";
import { DataIndexPage, DatasetDataPage } from "./pages/DatasetDataPage";
import { DatasetPage } from "./pages/DatasetPage";
import { DatasetsPage } from "./pages/DatasetsPage";
import { LoginPage } from "./pages/LoginPage";
import { RecordsIndexPage, RecordsPage } from "./pages/RecordsPage";
import { ForgotPasswordPage, ResetPasswordPage } from "./pages/PasswordResetPages";

// The explorer pulls in Cytoscape (most of the bundle): load it only when needed.
const RunExplorerPage = lazy(() =>
  import("./pages/ExplorerPages").then((m) => ({ default: m.RunExplorerPage })),
);
const LocalExplorerPage = lazy(() =>
  import("./pages/ExplorerPages").then((m) => ({ default: m.LocalExplorerPage })),
);
const ExploreIndexPage = lazy(() =>
  import("./pages/ExplorerPages").then((m) => ({ default: m.ExploreIndexPage })),
);
const Loading = ({ children }: { children: ReactNode }) => (
  <Suspense fallback={<p className="empty">Loading…</p>}>{children}</Suspense>
);

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/datasets" replace />} />
        <Route path="/datasets" element={<DatasetsPage />} />
        <Route path="/datasets/:datasetId" element={<DatasetPage />} />
        <Route path="/datasets/:datasetId/data" element={<DatasetDataPage />} />
        <Route path="/data" element={<DataIndexPage />} />
        <Route path="/datasets/:datasetId/records" element={<RecordsPage />} />
        <Route path="/records" element={<RecordsIndexPage />} />
        <Route
          path="/explore"
          element={
            <Loading>
              <ExploreIndexPage />
            </Loading>
          }
        />
        <Route
          path="/runs/:runId"
          element={
            <Loading>
              <RunExplorerPage />
            </Loading>
          }
        />
        <Route
          path="/local"
          element={
            <Loading>
              <LocalExplorerPage />
            </Loading>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/datasets" replace />} />
    </Routes>
  );
}
