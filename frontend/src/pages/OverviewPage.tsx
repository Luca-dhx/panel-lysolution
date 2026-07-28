// NIVEAU 0 de la divulgation progressive — la vue d'ouverture du Panel.
//
// Contrainte de conception : cette page doit rester lisible et rapide avec
// 3 projets comme avec 300. Elle n'affiche donc AUCUNE liste complète du
// parc : quelques indicateurs, ce qui demande attention, et une porte vers
// le niveau 1.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { Distribution, HealthBadge, LivenessBadge, Metric, SeverityBadge, formatDuration } from '@/components/supervision';
import { errorMessage, supervision } from '@/lib/api';
import type { Dashboard } from '@/types.supervision';

export function OverviewPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    supervision
      .dashboard()
      .then((d) => { if (active) setData(d); })
      .catch((err) => { if (active) setError(errorMessage(err, 'Tableau de bord indisponible.')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  if (loading) return <div className="page"><p className="muted">Chargement du parc…</p></div>;
  if (error || !data) {
    return (
      <div className="page">
        <div className="alert alert-error">{error ?? 'Tableau de bord indisponible.'}</div>
      </div>
    );
  }

  const { totals, health, alerts, panel } = data;
  const hasParc = totals.projects > 0;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Supervision</h1>
        <p className="page-description">
          État du parc L.Y Solution. Lecture seule : le Panel observe, il ne modifie aucun projet.
        </p>
      </header>

      {!hasParc ? (
        <Card>
          <EmptyState
            title="Aucun projet dans le registre"
            hint="Déclarez un projet depuis la page Projets, puis appairez-le pour le voir apparaître ici."
          />
        </Card>
      ) : null}

      {hasParc ? (
        <>
          {/* Trois nombres qui suffisent à savoir si la journée se passe bien. */}
          <div className="metric-row">
            <Metric value={totals.projects} label="Projets" />
            <Metric value={totals.online} label="En ligne" tone={totals.online > 0 ? 'ok' : undefined} />
            <Metric
              value={totals.stale}
              label="Signal périmé"
              tone={totals.stale > 0 ? 'warn' : undefined}
            />
            <Metric
              value={totals.offline}
              label="Hors ligne"
              tone={totals.offline > 0 ? 'danger' : undefined}
            />
            <Metric
              value={alerts.error}
              label="Alertes critiques"
              tone={alerts.error > 0 ? 'danger' : undefined}
            />
          </div>

          <div className="metric-row metric-row-secondary">
            <Metric value={totals.prod} label="PROD" />
            <Metric value={totals.test} label="TEST" />
            <Metric value={totals.paired} label="Appairés" />
            <Metric value={health.unknown} label="État inconnu" hint="Données non publiées" />
          </div>

          {/* Ce qui demande de l'attention — jamais toute la liste du parc. */}
          <Card title={`À regarder en priorité${data.attention.length ? ` (${data.attention.length})` : ''}`}>
            {data.attention.length === 0 ? (
              <p className="muted">Aucun projet en anomalie. Rien à signaler.</p>
            ) : (
              <ul className="attention-list">
                {data.attention.map((row) => (
                  <li key={row.projectId}>
                    <Link to={`/supervision/${row.projectId}`} className="attention-name">
                      {row.name}
                    </Link>
                    <span className="attention-badges">
                      <LivenessBadge value={row.liveness} />
                      <HealthBadge value={row.health} />
                    </span>
                    <span className="muted">
                      {row.secondsSinceLastHeartbeat === null
                        ? 'jamais vu'
                        : `vu il y a ${formatDuration(row.secondsSinceLastHeartbeat)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="card-footer-link">
              <Link to="/supervision">Voir tout le parc →</Link>
            </p>
          </Card>

          {alerts.items.length > 0 ? (
            <Card title={`Alertes (${alerts.total})`}>
              <ul className="alert-list">
                {alerts.items.map((alert, index) => (
                  <li key={`${alert.projectId}-${alert.code}-${index}`}>
                    <SeverityBadge value={alert.severity} />
                    <Link to={`/supervision/${alert.projectId}`}>{alert.projectName}</Link>
                    <span>{alert.message}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <div className="card-grid">
            <Card title="Versions de contrat">
              <Distribution data={data.versions.contract} />
            </Card>
            <Card title="Moteur de déploiement">
              <Distribution data={data.versions.deploymentEngine} />
            </Card>
            <Card title="Moteur de duplication">
              <Distribution data={data.versions.duplicationEngine} />
            </Card>
          </div>

          {data.recentActivity.length > 0 ? (
            <Card title="Activité récente">
              <ul className="timeline">
                {data.recentActivity.map((event, index) => (
                  <li key={`${event.projectId}-${event.occurredAt}-${index}`}>
                    <time>{new Date(event.occurredAt).toLocaleString()}</time>
                    <span className="timeline-summary">{event.summary}</span>
                    <span className="muted timeline-source">
                      {event.source === 'PROJECT' ? 'déclaré par le projet' : 'constaté par le Panel'}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      ) : null}

      <Card title="Référence du Panel">
        <p className="muted">
          Contrat de pont <code>{panel.contractVersion}</code> · seuils :
          {' '}signal périmé après {formatDuration(panel.thresholds.staleAfterS)},
          {' '}hors ligne après {formatDuration(panel.thresholds.offlineAfterS)}.
        </p>
      </Card>
    </div>
  );
}
