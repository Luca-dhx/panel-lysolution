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
import { useEvents, usePendingEvents } from '@/lib/useEvents';
import { EventConfirmation } from '@/components/EventConfirmation';
import { EventRow } from '@/pages/AgendaPage';
import { useIsDev } from '@/auth/RequireDev';
import {
  lastContact,
  projectAlert,
  projectDisplayName,
  siteState,
  toneBadgeClass,
} from '@/lib/projectPresentation';

export function DashboardPage() {
  const { projects, isInitialLoading, error } = useProjects();
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
          <span className="stat-value">{isInitialLoading ? '…' : declared}</span>
          <span className="stat-label">Projets clients</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-value">{isInitialLoading ? '…' : connected}</span>
          <span className="stat-label">Reliés au Panel</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-value">{isInitialLoading ? '…' : online}</span>
          <span className="stat-label">Sites en ligne</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-value">{isInitialLoading ? '…' : toCheck}</span>
          <span className="stat-label">À vérifier</span>
        </Card>
      </div>

      <AgendaDuJour />

      <Card title="Projets nécessitant une attention">
        {isInitialLoading ? (
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
        {isInitialLoading ? (
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


/* -------------------------------------------------------------------------- */

/**
 * LA JOURNÉE — ce qui attend une confirmation d'abord, le reste ensuite.
 *
 * L'ordre n'est pas décoratif : une confirmation en attente se périme, un
 * rendez-vous à venir non. Ce qui exige une action passe donc devant.
 */
function AgendaDuJour() {
  const { events: enAttente, reload: rechargerAttente } = usePendingEvents();
  const { events: aujourdhui } = useEvents('today');
  const { events: aVenir } = useEvents('upcoming');

  const prochains = aVenir.slice(0, 5);
  if (enAttente.length === 0 && aujourdhui.length === 0 && prochains.length === 0) return null;

  return (
    <>
      {enAttente.length > 0 ? (
        <Card title={`Confirmations en attente (${enAttente.length})`}>
          {enAttente.map((e) => (
            <EventConfirmation key={e._id} event={e} onResolved={() => void rechargerAttente()} />
          ))}
        </Card>
      ) : null}

      {aujourdhui.length > 0 ? (
        <Card title="Aujourd’hui">
          <ul className="event-list">
            {aujourdhui.map((e) => <EventRow key={e._id} event={e} />)}
          </ul>
        </Card>
      ) : null}

      {prochains.length > 0 ? (
        <Card title="Prochains rendez-vous">
          <ul className="event-list">
            {prochains.map((e) => <EventRow key={e._id} event={e} />)}
          </ul>
          <p><Link to="/agenda">Voir tout l’agenda →</Link></p>
        </Card>
      ) : null}
    </>
  );
}
