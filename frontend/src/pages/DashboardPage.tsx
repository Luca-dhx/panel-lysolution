import { Card } from '@/components/ui';
import { usePanelVersion } from '@/lib/usePanelVersion';
import { useProjects } from '@/lib/useProjects';

export function DashboardPage() {
  const { projects, loading, error } = useProjects();
  const { version, loading: versionLoading, error: versionError } = usePanelVersion();

  const declared = projects.length;
  const paired = projects.filter((p) => p.pairing.status === 'PAIRED').length;
  const online = projects.filter((p) => p.liveness === 'ONLINE').length;
  const offline = projects.filter((p) => p.liveness === 'OFFLINE').length;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dashboard</h1>
        <p className="page-description">Vue d’ensemble du parc de projets.</p>
      </header>

      <Card title="Squelette Phase 2B">
        <p>
          Bienvenue sur le Panel L.Y Solution. Cette version est un squelette d’infrastructure :
          gestion du parc, appairage des projets et suivi des ponts.
        </p>
      </Card>

      {error ? <div className="alert alert-error">{error}</div> : null}

      <div className="stat-grid">
        <Card className="stat-card">
          <span className="stat-value">{loading ? '…' : declared}</span>
          <span className="stat-label">Projets déclarés</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-value">{loading ? '…' : paired}</span>
          <span className="stat-label">Appairés</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-value">{loading ? '…' : online}</span>
          <span className="stat-label">En ligne</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-value">{loading ? '…' : offline}</span>
          <span className="stat-label">Hors ligne</span>
        </Card>
      </div>

      <Card title="Version du Panel">
        {versionLoading ? (
          <p className="muted">Chargement…</p>
        ) : version ? (
          <dl className="detail-list">
            <div>
              <dt>Nom</dt>
              <dd>{version.name}</dd>
            </div>
            <div>
              <dt>Version logicielle</dt>
              <dd>{version.softwareVersion}</dd>
            </div>
            <div>
              <dt>Version de contrat</dt>
              <dd>{version.contractVersion}</dd>
            </div>
            <div>
              <dt>Environnement</dt>
              <dd>{version.environment}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">{versionError ?? 'Version indisponible.'}</p>
        )}
      </Card>

      <div className="alert alert-info">
        Les modules métier (contrats, factures, CRM…) arriveront en Phase 3.
      </div>
    </div>
  );
}
