/**
 * TABLEAU DE BORD — l'accueil de toute l'équipe, pas une console d'exploitation.
 *
 * Cette page répondait auparavant à des questions d'infrastructure : combien de
 * projets « appairés », quelle distribution de versions de contrat, quels
 * seuils de heartbeat. Un commercial n'a rien à en faire. Elle répond
 * désormais à ce qu'on veut savoir en arrivant : combien de sites, lesquels
 * vont bien, lesquels demandent une attention — et le dit en français.
 *
 * Elle n'affiche QUE des données réellement disponibles. Les indicateurs
 * contractuels et financiers (contrats actifs, impayés, échéances) attendent
 * une remontée métier qui n'existe pas encore : les inventer donnerait un
 * tableau de bord faux, ce qui est pire qu'un tableau de bord incomplet.
 */
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { useProjects } from '@/lib/useProjects';
import { useIsDev } from '@/auth/RequireDev';
import {
  lastContact,
  projectAlert,
  projectDisplayName,
  siteState,
  toneBadgeClass,
} from '@/lib/projectPresentation';

export function DashboardPage() {
  const { projects, loading, error } = useProjects();
  const isDev = useIsDev();

  const declared = projects.length;
  const connected = projects.filter((p) => p.pairing.status === 'PAIRED').length;
  const online = projects.filter((p) => p.liveness === 'ONLINE').length;
  const toCheck = projects.filter(
    (p) => p.liveness === 'OFFLINE' || p.liveness === 'STALE',
  ).length;

  const alerts = projects.map(projectAlert).filter((a): a is NonNullable<typeof a> => a !== null);

  // Dernière activité connue : le contact le plus récent du parc. C'est la
  // seule chronologie dont on dispose — il n'existe aucun journal métier.
  const recent = [...projects]
    .filter((p) => p.runtime.lastHeartbeatAt)
    .sort((a, b) =>
      (b.runtime.lastHeartbeatAt ?? '').localeCompare(a.runtime.lastHeartbeatAt ?? ''),
    )
    .slice(0, 5);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Tableau de bord</h1>
        <p className="page-description">Vue d’ensemble des projets clients.</p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      <div className="stat-grid">
        <Card className="stat-card">
          <span className="stat-value">{loading ? '…' : declared}</span>
          <span className="stat-label">Projets clients</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-value">{loading ? '…' : connected}</span>
          <span className="stat-label">Reliés au Panel</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-value">{loading ? '…' : online}</span>
          <span className="stat-label">Sites en ligne</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-value">{loading ? '…' : toCheck}</span>
          <span className="stat-label">À vérifier</span>
        </Card>
      </div>

      <Card title="Projets nécessitant une attention">
        {loading ? (
          <p className="muted">Chargement…</p>
        ) : alerts.length === 0 ? (
          <EmptyState
            title="Rien à signaler"
            hint="Tous les projets clients communiquent normalement avec le Panel."
          />
        ) : (
          <ul className="plain-list">
            {alerts.map((alert) => (
              <li key={alert.projectId} className="alert-row">
                <span className={toneBadgeClass(alert.tone)}>
                  {alert.tone === 'error' ? 'Urgent' : 'À suivre'}
                </span>
                <span className="alert-row-body">
                  <Link to={`/projects/${alert.projectId}`}>{alert.projectName}</Link>
                  {' — '}
                  {alert.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Dernières activités">
        {loading ? (
          <p className="muted">Chargement…</p>
        ) : recent.length === 0 ? (
          <EmptyState
            title="Aucune activité"
            hint="Aucun projet n’a encore communiqué avec le Panel."
          />
        ) : (
          <ul className="plain-list">
            {recent.map((project) => {
              const site = siteState(project);
              const since = lastContact(project);
              return (
                <li key={project.projectId} className="alert-row">
                  <span className={toneBadgeClass(site.tone)}>{site.label}</span>
                  <span className="alert-row-body">
                    <Link to={`/projects/${project.projectId}`}>
                      {projectDisplayName(project)}
                    </Link>
                    {since ? <span className="muted"> · dernier contact {since}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Les indicateurs contractuels et financiers demandent une remontée
          métier qui n'existe pas encore. On le dit plutôt que d'afficher des
          compteurs à zéro, qui se liraient comme « aucun contrat ». */}
      <div className="alert alert-info">
        Les contrats, factures et rendez-vous ne sont pas encore remontés depuis les sites clients :
        ces indicateurs apparaîtront ici une fois la synchronisation métier en place.
        {isDev ? (
          <>
            {' '}
            <Link to="/supervision">Voir la supervision technique →</Link>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default DashboardPage;
