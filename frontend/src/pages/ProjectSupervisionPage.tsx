// NIVEAUX 2 et 3 de la divulgation progressive — la fiche projet.
//
// Niveau 2 (immédiat)  : identité, santé, réseau, versions — ce qu'on veut
//                        savoir en ouvrant la fiche.
// Niveau 3 (à la demande) : manifeste brut, historique de heartbeats,
//                        chronologie complète. Ces blocs sont repliés ET
//                        leur contenu n'est CHARGÉ qu'à la première ouverture.
//
// Lecture seule intégrale : aucun bouton d'action n'existe sur cette page.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card } from '@/components/ui';
import {
  DetailList, Disclosure, HealthBadge, LivenessBadge, SeverityBadge,
  formatDuration, orUnknown,
} from '@/components/supervision';
import { errorMessage, supervision } from '@/lib/api';
import type {
  HeartbeatRow, HeartbeatStats, ProjectOverview, ProjectTechnical, TimelineEvent,
} from '@/types.supervision';

export function ProjectSupervisionPage() {
  const { projectId = '' } = useParams();
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Niveau 3 : chargés seulement si l'utilisateur déplie.
  const [technical, setTechnical] = useState<ProjectTechnical | null>(null);
  const [heartbeats, setHeartbeats] = useState<{ stats: HeartbeatStats; items: HeartbeatRow[] } | null>(null);
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);

  useEffect(() => {
    let active = true;
    supervision
      .project(projectId)
      .then((d) => { if (active) setOverview(d); })
      .catch((err) => { if (active) setError(errorMessage(err, 'Projet introuvable.')); });
    return () => { active = false; };
  }, [projectId]);

  if (error) {
    return (
      <div className="page">
        <div className="alert alert-error">{error}</div>
        <p><Link to="/supervision/parc">← Retour au parc</Link></p>
      </div>
    );
  }
  if (!overview) return <div className="page"><p className="muted">Chargement…</p></div>;

  const { descriptor, health, capabilities } = overview;
  const secondsSince = descriptor.dates.lastHeartbeatAt
    ? Math.round((Date.now() - new Date(descriptor.dates.lastHeartbeatAt).getTime()) / 1000)
    : null;

  return (
    <div className="page">
      <p className="breadcrumb"><Link to="/supervision/parc">← Parc</Link></p>

      <header className="page-header">
        <h1>{descriptor.name}</h1>
        <p className="page-description">
          <code>{descriptor.slug}</code>
          {descriptor.description ? ` · ${descriptor.description}` : null}
        </p>
        <p className="tab-links">
          <Link to={`/supervision/${projectId}/diagnostic`} className="tab-link">
            Voir le diagnostic complet →
          </Link>
          {/* Phase 3C : le pilotage part d'ici, mais rien ne se déclenche au
              clic — l'écran suivant prépare et vérifie avant de proposer. */}
          <Link to={`/supervision/${projectId}/actions`} className="tab-link">
            Piloter ce projet →
          </Link>
        </p>
        <div className="header-badges">
          <LivenessBadge value={health.liveness} />
          <HealthBadge value={health.status} />
          {descriptor.environment ? <span className="badge badge-neutral">{descriptor.environment}</span> : null}
        </div>
      </header>

      {/* — Niveau 2 : l'essentiel, tout de suite ————————————————— */}
      <div className="card-grid">
        <Card title="Général">
          <DetailList
            items={[
              ['Nom', descriptor.name],
              ['Slug', <code key="slug">{descriptor.slug}</code>],
              ['Type', orUnknown(descriptor.type, 'Le projet ne publie pas son type.')],
              ['Layout', orUnknown(descriptor.layout, 'Topologie non publiée.')],
              ['Manifest', overview.manifestSource === 'BRIDGE'
                ? 'reçu par le pont (fait foi)'
                : overview.manifestSource === 'MANUAL' ? 'saisi manuellement' : <span className="muted">absent</span>],
            ]}
          />
        </Card>

        <Card title="Réseau">
          <DetailList
            items={[
              ['Domaine principal', orUnknown(descriptor.primaryDomain, 'Non publié par le projet.')],
              ...Object.entries(descriptor.urls ?? {}).map(
                ([key, url]) => [key, <code key={key}>{url}</code>] as [string, React.ReactNode],
              ),
            ]}
          />
        </Card>

        <Card title="Versions">
          <DetailList
            items={[
              ['Application', orUnknown(descriptor.versions.software)],
              ['Contrat de pont', orUnknown(descriptor.versions.contract)],
              ['Format de manifeste', orUnknown(descriptor.versions.manifestFormat)],
              ['Moteur de déploiement', orUnknown(descriptor.versions.deploymentEngine, 'Contrat < 1.2.0 ?')],
              ['Moteur de duplication', orUnknown(descriptor.versions.duplicationEngine, 'Contrat < 1.2.0 ?')],
            ]}
          />
        </Card>

        <Card title="Chronologie clé">
          <DetailList
            items={[
              ['Déclaré le', new Date(descriptor.dates.createdAt).toLocaleString()],
              ['Appairé le', descriptor.dates.pairedAt
                ? new Date(descriptor.dates.pairedAt).toLocaleString()
                : <span className="muted">jamais</span>],
              ['Dernier signal', descriptor.dates.lastHeartbeatAt
                ? `${new Date(descriptor.dates.lastHeartbeatAt).toLocaleString()} (il y a ${formatDuration(secondsSince)})`
                : <span className="muted">jamais</span>],
            ]}
          />
        </Card>
      </div>

      {/* — Convergence ————————————————————————————————————————
          Ce que le Panel a PUBLIÉ face à ce que le projet a APPLIQUÉ. Sans
          cette confrontation, le Panel ne saurait que ce qu'il a émis. */}
      <Card title="Configuration d’entreprise">
        <p className={`mode-notice ${overview.convergence.status === 'CONVERGED' ? 'mode-simulation' : 'mode-execution'}`}>
          {overview.convergence.reason}
        </p>
        <DetailList
          items={[
            ['Version publiée par le Panel',
              overview.convergence.publishedVersion ?? <span className="muted">aucune</span>],
            ['Version appliquée par le projet',
              overview.convergence.appliedVersion ?? <span className="muted">inconnue</span>],
            ['API intégrées reçues',
              overview.convergence.integratedApiKeys.length > 0
                ? overview.convergence.integratedApiKeys.join(' · ')
                : <span className="muted">aucune</span>],
            ['Constaté le',
              overview.convergence.observedAt ?? <span className="muted">jamais</span>],
          ]}
        />
        {overview.convergence.status === 'UNKNOWN' ? (
          <p className="muted">
            <Link to={`/supervision/${projectId}/actions?futureAction=FETCH_MANIFEST`}>
              Découvrir le projet →
            </Link>
          </p>
        ) : null}
      </Card>

      {/* — Santé par composant ————————————————————————————————— */}
      <Card title="Santé par composant">
        <ul className="component-list">
          {health.components.map((component) => (
            <li key={component.id}>
              <HealthBadge value={component.status} />
              <span className="component-id">{component.id}</span>
              <span className="component-detail">{component.detail}</span>
              <span className="muted component-source">
                {component.source === 'PROJECT' ? 'déclaré par le projet'
                  : component.source === 'PANEL' ? 'constaté par le Panel'
                    : 'non publié'}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {/* — Capacités ——————————————————————————————————————————— */}
      <Card title="Capacités déclarées">
        <DetailList
          items={[
            ['Modules actifs', capabilities.modules.active.length
              ? capabilities.modules.active.join(', ')
              : <span className="muted">aucun</span>],
            ['Modules optionnels', capabilities.modules.optional.length
              ? capabilities.modules.optional.join(', ')
              : <span className="muted">aucun</span>],
            ['Fonctionnalités actives', capabilities.enabled.length
              ? capabilities.enabled.join(', ')
              : <span className="muted">aucune</span>],
            ['Fonctionnalités réservées', capabilities.reserved.length
              ? capabilities.reserved.join(', ')
              : <span className="muted">aucune</span>],
            ['Types synchronisés', capabilities.sync.supportedEntityTypes.length
              ? capabilities.sync.supportedEntityTypes.join(', ')
              : <span className="muted">aucun</span>],
          ]}
        />
        {capabilities.unknown.length > 0 ? (
          <p className="alert alert-info">
            Fonctionnalités inconnues de ce Panel (tolérées, ignorées) : {capabilities.unknown.join(', ')}
          </p>
        ) : null}
      </Card>

      {/* — Niveau 3 : détails techniques, chargés à la demande ————— */}
      <Disclosure
        title="Historique des signaux"
        hint="heartbeats reçus"
        onOpen={() => {
          if (!heartbeats) supervision.heartbeats(projectId, 30).then(setHeartbeats).catch(() => setHeartbeats(null));
        }}
      >
        {!heartbeats ? <p className="muted">Chargement…</p> : (
          <>
            <DetailList
              items={[
                ['Signaux archivés', heartbeats.stats.count],
                ['Cadence moyenne', heartbeats.stats.averageIntervalS === null
                  ? <span className="muted">—</span>
                  : formatDuration(heartbeats.stats.averageIntervalS)],
                ['Cadence attendue', formatDuration(heartbeats.stats.expectedIntervalS)],
                ['Régularité', heartbeats.stats.regular === null
                  ? <span className="muted">—</span>
                  : heartbeats.stats.regular ? 'régulière' : 'irrégulière'],
              ]}
            />
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Reçu</th><th>Version</th><th>Santé</th><th>Uptime</th><th>Mémoire</th></tr>
                </thead>
                <tbody>
                  {heartbeats.items.map((row, index) => (
                    <tr key={`${row.receivedAt}-${index}`}>
                      <td>{new Date(row.receivedAt).toLocaleString()}</td>
                      <td>{orUnknown(row.softwareVersion)}</td>
                      <td>{orUnknown(row.healthStatus)}</td>
                      <td>{formatDuration(row.uptimeSeconds)}</td>
                      <td>{row.load?.memoryUsedMb ? `${row.load.memoryUsedMb} Mo` : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Disclosure>

      <Disclosure
        title="Chronologie complète"
        hint="événements reçus et constatés"
        onOpen={() => {
          if (!events) supervision.projectEvents(projectId, 100).then((r) => setEvents(r.items)).catch(() => setEvents([]));
        }}
      >
        {!events ? <p className="muted">Chargement…</p> : events.length === 0 ? (
          <p className="muted">Aucun événement enregistré.</p>
        ) : (
          <ul className="timeline">
            {events.map((event, index) => (
              <li key={`${event.occurredAt}-${index}`}>
                <time>{new Date(event.occurredAt).toLocaleString()}</time>
                {event.severity !== 'INFO' ? <SeverityBadge value={event.severity} /> : null}
                <span className="timeline-summary">{event.summary}</span>
                <span className="muted timeline-source">
                  {event.source === 'PROJECT' ? 'déclaré par le projet' : 'constaté par le Panel'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Disclosure>

      <Disclosure
        title="Manifeste et état brut"
        hint="données techniques"
        onOpen={() => {
          if (!technical) supervision.technical(projectId).then(setTechnical).catch(() => setTechnical(null));
        }}
      >
        {!technical ? <p className="muted">Chargement…</p> : (
          <>
            <h3 className="subsection-title">Manifeste publié</h3>
            {technical.manifest ? (
              <pre className="code-block">{JSON.stringify(technical.manifest, null, 2)}</pre>
            ) : (
              <p className="muted">Aucun manifeste publié par ce projet.</p>
            )}
            <h3 className="subsection-title">Dernier état runtime</h3>
            <pre className="code-block">{JSON.stringify(technical.runtime, null, 2)}</pre>
          </>
        )}
      </Disclosure>

      <p className="muted read-only-note">
        Cette page est en lecture seule : le Panel n’écrit jamais dans un projet.
      </p>
    </div>
  );
}
