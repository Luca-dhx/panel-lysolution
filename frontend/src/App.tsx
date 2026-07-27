import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from '@/auth/RequireAuth';
import { Layout } from '@/components/Layout';
import { BridgesPage } from '@/pages/BridgesPage';
import { DashboardPage } from '@/pages/DashboardPage';
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
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/bridges" element={<BridgesPage />} />
        <Route path="/versions" element={<VersionsPage />} />
        <Route path="/pairings" element={<PairingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
