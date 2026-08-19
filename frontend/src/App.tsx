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
import { IntegratedApiControlPlanePage } from '@/pages/IntegratedApiControlPlanePage';
import { IntegratedApisPage } from '@/pages/IntegratedApisPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { EmailSenderPage } from '@/pages/EmailSenderPage';
import { EmailTemplatesPage } from '@/pages/EmailTemplatesPage';
import { FinancesPage } from '@/pages/FinancesPage';
import { FleetPage } from '@/pages/FleetPage';
import { FederationAuthorizePage } from '@/pages/FederationAuthorizePage';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { ExecutionPage } from '@/pages/ExecutionPage';
import { ProjectActionsPage } from '@/pages/ProjectActionsPage';
import { ProjectDiagnosticPage } from '@/pages/ProjectDiagnosticPage';
import { ProjectSupervisionPage } from '@/pages/ProjectSupervisionPage';
import { ProjectDetailPage } from '@/pages/ProjectDetailPage';
import { LoginPage } from '@/pages/LoginPage';
import { MyProfilePage } from '@/pages/MyProfilePage';
import { PanelUsersPage } from '@/pages/PanelUsersPage';
import { PairingsPage } from '@/pages/PairingsPage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { AgendaPage } from '@/pages/AgendaPage';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage';
import { ThemePage } from '@/pages/ThemePage';
import { useThemeLoader } from '@/lib/useTheme';
import { useFaviconLoader } from '@/lib/useFavicon';
import { VersionsPage } from '@/pages/VersionsPage';

/** Enveloppe DEV — une seule barrière, jamais dupliquée dans les pages. */
const dev = (element: JSX.Element) => <RequireDev>{element}</RequireDev>;

export default function App() {
  // Le thème enregistré est appliqué dès l'ouverture : sans cela, l'écran
  // afficherait une seconde les couleurs par défaut avant de se repeindre.
  useThemeLoader();
  // Même geste pour l'onglet : le favicon configuré dans « Mon entreprise »
  // était téléversé et publié, mais aucun écran ne le posait.
  useFaviconLoader();

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      {/*
        AUTORISATION D'ACCÈS PROJET (L12.B-UI) — sous `RequireAuth`, mais HORS
        du `Layout`.

        Sous la garde : un visiteur non connecté est renvoyé au login, qui le
        ramène ici AVEC SES PARAMÈTRES (cf. `retourApresConnexion`). C'est ce
        qui rend le parcours fluide pour un développeur qui n'avait pas de
        session Panel ouverte.

        Hors du gabarit : cette page ne fait que rebondir vers le projet. Lui
        peindre une barre latérale et un menu donnerait l'impression d'une
        destination alors qu'elle est un couloir.
      */}
      <Route
        path="/federation/authorize"
        element={
          <RequireAuth>
            <FederationAuthorizePage />
          </RequireAuth>
        }
      />
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
        {/*
          FINANCES — GESTION, et non DÉVELOPPEUR : c'est la donnée de gestion
          par excellence. La réserver aux comptes DEV ferait du développeur le
          seul lecteur du chiffre d'affaires. Le backend applique la même règle,
          et c'est LUI la barrière — cette route ne fait que la refléter.
        */}
        <Route path="/finances" element={<FinancesPage />} />
        <Route path="/company" element={<CompanyPage />} />
        {/*
          MON PROFIL — accessible à TOUT compte du Panel, ADMIN compris.

          Elle est donc en section GESTION, et non parmi les surfaces DEV :
          corriger son propre nom n'est pas une opération technique. C'est aussi
          pour cela qu'elle n'apparaît dans aucun menu — on y accède par le pied
          de la barre latérale, là où l'on lit déjà son identité.
        */}
        <Route path="/mon-profil" element={<MyProfilePage />} />

        {/* ── DÉVELOPPEUR — routes réellement interdites aux ADMIN ──────── */}
        {/* Divulgation progressive : vue globale → parc → fiche technique. */}
        {/*
          LES COMPTES DE L'ÉQUIPE — DEV uniquement, comme les autres surfaces
          techniques.

          Ce que cet écran accorde n'est pas un droit DANS le Panel, mais un
          droit CHEZ UN CLIENT. Décider qui entre dans le code d'un garage est
          une décision technique — l'ouvrir aux ADMIN reviendrait à laisser un
          rôle non-développeur accorder un accès développeur.
        */}
        <Route path="/panel-users" element={dev(<PanelUsersPage />)} />
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
        {/*
          L1 — le plan de contrôle prend l'adresse principale. L'ancien coffre
          reste joignable : il diffuse encore des identifiants aux projets
          appairés, et le retirer AVANT L4 couperait un chemin en service.
        */}
        <Route path="/integrated-apis" element={dev(<IntegratedApiControlPlanePage />)} />
        {/*
          L'expéditeur global (R10.4). Sous garde DEV comme les autres surfaces
          d'infrastructure : l'écriture change l'expéditeur de tout le parc, et
          le test envoie un e-mail RÉEL sur le compte de la plateforme.
        */}
        <Route path="/email-sender" element={dev(<EmailSenderPage />)} />
        <Route path="/email-templates" element={dev(<EmailTemplatesPage />)} />
        <Route path="/integrated-apis/legacy" element={dev(<IntegratedApisPage />)} />
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
