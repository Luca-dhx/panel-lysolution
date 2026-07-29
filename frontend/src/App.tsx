import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@/auth/RequireAuth';
import { Layout } from '@/components/Layout';
import { ActionsPage } from '@/pages/ActionsPage';
import { BridgesPage } from '@/pages/BridgesPage';
import { CompanyPage } from '@/pages/CompanyPage';
import { IntegratedApisPage } from '@/pages/IntegratedApisPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { FleetPage } from '@/pages/FleetPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { ExecutionPage } from '@/pages/ExecutionPage';
import { ProjectActionsPage } from '@/pages/ProjectActionsPage';
import { ProjectDiagnosticPage } from '@/pages/ProjectDiagnosticPage';
import { ProjectSupervisionPage } from '@/pages/ProjectSupervisionPage';
import { LoginPage } from '@/pages/LoginPage';
import { PairingsPage } from '@/pages/PairingsPage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { VersionsPage } from '@/pages/VersionsPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        {/* Divulgation progressive : vue globale → parc → fiche projet. */}
        <Route path="/" element={<OverviewPage />} />
        <Route path="/supervision" element={<FleetPage />} />
        <Route path="/supervision/:projectId" element={<ProjectSupervisionPage />} />
        <Route path="/supervision/:projectId/diagnostic" element={<ProjectDiagnosticPage />} />
        {/* Pilotage : on observe les exécutions ici, on en prépare une depuis un projet. */}
        <Route path="/supervision/:projectId/actions" element={<ProjectActionsPage />} />
        <Route path="/company" element={<CompanyPage />} />
        <Route path="/integrated-apis" element={<IntegratedApisPage />} />
        <Route path="/actions" element={<ActionsPage />} />
        <Route path="/actions/:executionId" element={<ExecutionPage />} />
        <Route path="/panel" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/bridges" element={<BridgesPage />} />
        <Route path="/versions" element={<VersionsPage />} />
        <Route path="/pairings" element={<PairingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
