import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@/auth/RequireAuth';
import { RequireDev } from '@/auth/RequireDev';
import { Layout } from '@/components/Layout';
import { ActionsPage } from '@/pages/ActionsPage';
import { BridgesPage } from '@/pages/BridgesPage';
import { CompanyPage } from '@/pages/CompanyPage';
import { DeploymentPage } from '@/pages/DeploymentPage';
import { DeploymentRunPage } from '@/pages/DeploymentRunPage';
import { DeploymentTargetPage } from '@/pages/DeploymentTargetPage';
import { IntegratedApisPage } from '@/pages/IntegratedApisPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { FleetPage } from '@/pages/FleetPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { ExecutionPage } from '@/pages/ExecutionPage';
import { ProjectActionsPage } from '@/pages/ProjectActionsPage';
import { ProjectDiagnosticPage } from '@/pages/ProjectDiagnosticPage';
import { ProjectSupervisionPage } from '@/pages/ProjectSupervisionPage';
import { ProjectDetailPage } from '@/pages/ProjectDetailPage';
import { LoginPage } from '@/pages/LoginPage';
import { PairingsPage } from '@/pages/PairingsPage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { AgendaPage } from '@/pages/AgendaPage';
import { ThemePage } from '@/pages/ThemePage';
import { useThemeLoader } from '@/lib/useTheme';
import { VersionsPage } from '@/pages/VersionsPage';

/** Enveloppe DEV — une seule barrière, jamais dupliquée dans les pages. */
const dev = (element: JSX.Element) => <RequireDev>{element}</RequireDev>;

export default function App() {
  // Le thème enregistré est appliqué dès l'ouverture : sans cela, l'écran
  // afficherait une seconde les couleurs par défaut avant de se repeindre.
  useThemeLoader();

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
        {/* ── GESTION — accessible à toute l'équipe ─────────────────────── */}
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/agenda" element={<AgendaPage />} />
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="/company" element={<CompanyPage />} />

        {/* ── DÉVELOPPEUR — routes réellement interdites aux ADMIN ──────── */}
        {/* Divulgation progressive : vue globale → parc → fiche technique. */}
        <Route path="/theme" element={dev(<ThemePage />)} />
        <Route path="/supervision" element={dev(<OverviewPage />)} />
        <Route path="/supervision/parc" element={dev(<FleetPage />)} />
        <Route path="/supervision/:projectId" element={dev(<ProjectSupervisionPage />)} />
        <Route path="/supervision/:projectId/diagnostic" element={dev(<ProjectDiagnosticPage />)} />
        {/* Pilotage : on observe les exécutions ici, on en prépare une depuis un projet. */}
        <Route path="/supervision/:projectId/actions" element={dev(<ProjectActionsPage />)} />
        {/* Déploiement : destinations → fiche → suivi d'une exécution. */}
        <Route path="/deployment" element={dev(<DeploymentPage />)} />
        <Route path="/deployment/runs/:runId" element={dev(<DeploymentRunPage />)} />
        <Route path="/deployment/:targetId" element={dev(<DeploymentTargetPage />)} />
        <Route path="/integrated-apis" element={dev(<IntegratedApisPage />)} />
        <Route path="/actions" element={dev(<ActionsPage />)} />
        <Route path="/actions/:executionId" element={dev(<ExecutionPage />)} />
        <Route path="/bridges" element={dev(<BridgesPage />)} />
        <Route path="/versions" element={dev(<VersionsPage />)} />
        <Route path="/pairings" element={dev(<PairingsPage />)} />

        {/* ── ANCIENNES URLS — les favoris continuent de fonctionner ────── */}
        {/* `/panel` dupliquait la vue d'ensemble ; elle est devenue l'accueil. */}
        <Route path="/panel" element={<Navigate to="/" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
