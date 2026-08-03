/**
 * FICHE PROJET — le point d'entrée unique sur un client.
 *
 * Les informations d'un projet étaient dispersées : la liste montrait sa clé
 * technique, la supervision son descripteur, le diagnostic sa santé, une autre
 * page ses actions. Un même projet se lisait sur quatre écrans, tous rédigés
 * pour des développeurs. Cette fiche rassemble : ce qui concerne le client
 * dans « Vue d'ensemble », tout le technique dans un onglet réservé aux DEV.
 *
 * L'onglet Développeur n'est pas seulement masqué : un ADMIN qui manipulerait
 * l'URL n'obtiendrait rien de plus, l'onglet n'étant pas rendu pour lui.
 *
 * Aucun encart « Contrat », « Factures » ou « Réunions » n'est affiché : ces
 * données ne remontent pas encore des sites. Un cadre vide se lirait comme
 * « ce client n'a pas de contrat », ce qui serait faux.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useIsDev } from '@/auth/RequireDev';
import type { PublicProject } from '@/types';
import {
  connectionState,
  lastContact,
  linkState,
  projectAlert,
  projectDescription,
  projectDisplayName,
  projectInitials,
  projectSiteUrl,
  siteState,
  toneBadgeClass,
} from '@/lib/projectPresentation';

type Tab = 'overview' | 'dev';

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const isDev = useIsDev();
  const [project, setProject] = useState<PublicProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getProject(projectId as string)
      .then((data) => {
        if (!cancelled) setProject(data.project);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, 'Projet introuvable.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) return <div className="page"><p className="muted">Chargement du projet…</p></div>;
  if (error || !project) {
    return (
      <div className="page">
        <div className="alert alert-error">{error ?? 'Projet introuvable.'}</div>
        <p><Link to="/projects">← Retour aux projets clients</Link></p>
      </div>
    );
  }

  const site = siteState(project);
  const link = linkState(project);
  const connection = connectionState(project);
  const url = projectSiteUrl(project);
  const description = projectDescription(project);
  const alert = projectAlert(project);
  const since = lastContact(project);

  return (
    <div className="page">
      <p className="breadcrumb"><Link to="/projects">← Projets clients</Link></p>

      {/* ── EN-TÊTE ─────────────────────────────────────────────────────── */}
      <header className="page-header">
        <div className="project-row">
          <span className="project-avatar">{projectInitials(project)}</span>
          <div className="project-row-main">
            <h1>{projectDisplayName(project)}</h1>
            {description ? <p className="page-description">{description}</p> : null}
            <div className="project-row-meta">
              <span className={toneBadgeClass(site.tone)}>{site.label}</span>
              <span className={toneBadgeClass(connection.tone)}>{connection.label}</span>
              {since ? <span>Dernier contact {since}</span> : null}
            </div>
          </div>
          {url ? (
            <a className="btn btn-secondary btn-small" href={url} target="_blank" rel="noreferrer">
              Ouvrir le site
            </a>
          ) : null}
        </div>
      </header>

      {alert ? <div className={`alert alert-${alert.tone === 'error' ? 'error' : 'warning'}`}>{alert.message}</div> : null}

      <div className="tabs">
        <button
          type="button"
          className={tab === 'overview' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('overview')}
        >
          Vue d’ensemble
        </button>
        {isDev ? (
          <button
            type="button"
            className={tab === 'dev' ? 'tab tab-active' : 'tab'}
            onClick={() => setTab('dev')}
          >
            Développeur
          </button>
        ) : null}
      </div>

      {tab === 'overview' ? (
        <OverviewTab project={project} url={url} since={since} link={link} />
      ) : null}
      {tab === 'dev' && isDev ? <DeveloperTab project={project} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function OverviewTab({
  project,
  url,
  since,
  link,
}: {
  project: PublicProject;
  url: string | null;
  since: string | null;
  link: { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral' };
}) {
  const site = siteState(project);
  const lastSync = project.runtime.bridgeStats?.lastSyncAt ?? null;

  return (
    <>
      <Card title="Le site">
        <dl className="detail-list">
          <div>
            <dt>État du site</dt>
            <dd><span className={toneBadgeClass(site.tone)}>{site.label}</span></dd>
          </div>
          <div>
            <dt>Adresse publique</dt>
            <dd>
              {url ? (
                <a href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//, '')}</a>
              ) : (
                <span className="muted">non communiquée</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Lien avec le Panel</dt>
            <dd><span className={toneBadgeClass(link.tone)}>{link.label}</span></dd>
          </div>
          <div>
            <dt>Dernier contact</dt>
            <dd>{since ?? <span className="muted">jamais</span>}</dd>
          </div>
          <div>
            <dt>Dernière mise à jour des informations</dt>
            <dd>{lastSync ? formatDateTime(lastSync) : <span className="muted">jamais</span>}</dd>
          </div>
        </dl>
      </Card>

      <Card title="Suivi">
        <dl className="detail-list">
          <div>
            <dt>Ajouté le</dt>
            <dd>{formatDateTime(project.createdAt)}</dd>
          </div>
          <div>
            <dt>Relié le</dt>
            <dd>
              {project.pairing.pairedAt
                ? formatDateTime(project.pairing.pairedAt)
                : <span className="muted">pas encore</span>}
            </dd>
          </div>
        </dl>
        {project.note ? (
          <p className="cell-secondary">{project.note}</p>
        ) : (
          <p className="muted">Aucune note interne.</p>
        )}
      </Card>

      {/* Ce qui manque est DIT, jamais simulé par un encart vide. */}
      <div className="alert alert-info">
        Le contrat, les factures, les rendez-vous et l’historique des échanges ne sont pas encore
        remontés depuis le site : ils apparaîtront ici une fois la synchronisation métier en place.
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * ONGLET DÉVELOPPEUR — tout le technique, regroupé et nommé sans détour.
 * Les développeurs gardent leur vocabulaire : c'est lui qui sert au diagnostic.
 */
function DeveloperTab({ project }: { project: PublicProject }) {
  const [rawOpen, setRawOpen] = useState(false);
  const d = project.descriptor;

  return (
    <>
      <Card title="Connexion au Panel">
        <dl className="detail-list">
          <div><dt>Appairage</dt><dd>{project.pairing.status}</dd></div>
          <div><dt>Appairé le</dt><dd>{formatDateTime(project.pairing.pairedAt)}</dd></div>
          <div><dt>Révoqué le</dt><dd>{formatDateTime(project.pairing.revokedAt)}</dd></div>
          <div><dt>Liveness</dt><dd>{project.liveness}</dd></div>
          <div>
            <dt>Dernier heartbeat</dt>
            <dd>
              {formatDateTime(project.runtime.lastHeartbeatAt)}
              {project.secondsSinceLastHeartbeat !== null
                ? ` (${project.secondsSinceLastHeartbeat} s)`
                : ''}
            </dd>
          </div>
          <div>
            <dt>Curseur de synchronisation</dt>
            <dd>{project.runtime.bridgeStats?.lastSyncAt ?? '—'}</dd>
          </div>
          <div>
            <dt>Outbox</dt>
            <dd>{project.runtime.bridgeStats?.outboxSize ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      <Card title="Fiche technique du projet">
        <dl className="detail-list">
          <div><dt>Identifiant technique</dt><dd><code className="inline-code">{project.projectKey}</code></dd></div>
          <div><dt>URL du backend</dt><dd>{project.runtime.publicBackendUrl ?? '—'}</dd></div>
          <div><dt>Environnement</dt><dd>{project.runtime.environment ?? '—'}</dd></div>
          <div><dt>Version applicative</dt><dd>{d?.versions?.software ?? '—'}</dd></div>
          <div><dt>Version de contrat Bridge</dt><dd>{d?.versions?.contract ?? '—'}</dd></div>
          <div><dt>Format de manifeste</dt><dd>{d?.versions?.manifestFormat ?? '—'}</dd></div>
          <div><dt>Moteur de déploiement</dt><dd>{d?.versions?.deploymentEngine ?? '—'}</dd></div>
          <div><dt>Moteur de duplication</dt><dd>{d?.versions?.duplicationEngine ?? '—'}</dd></div>
          <div><dt>Type</dt><dd>{d?.type ?? '—'}</dd></div>
          <div><dt>Topologie</dt><dd>{d?.layout ?? '—'}</dd></div>
          <div><dt>Domaine principal</dt><dd>{d?.primaryDomain ?? '—'}</dd></div>
          <div><dt>Manifeste reçu le</dt><dd>{formatDateTime(project.manifestUpdatedAt)}</dd></div>
          <div><dt>Source du manifeste</dt><dd>{project.manifestSource ?? '—'}</dd></div>
        </dl>
      </Card>

      <Card title="Santé et capacités">
        <dl className="detail-list">
          <div><dt>Health</dt><dd>{project.runtime.lastHealth?.status ?? '—'}</dd></div>
          <div><dt>Détail</dt><dd>{project.runtime.lastHealth?.details ?? '—'}</dd></div>
        </dl>
        <p className="cell-secondary">
          Capacités actives :{' '}
          {project.capabilities.enabled.length > 0 ? (
            <span className="badge-list">
              {project.capabilities.enabled.map((c) => (
                <span key={c} className="badge badge-neutral">{c}</span>
              ))}
            </span>
          ) : (
            <span className="muted">aucune</span>
          )}
        </p>
      </Card>

      <Card title="Configuration appliquée">
        {project.appliedConfiguration ? (
          <dl className="detail-list">
            <div><dt>Entreprise</dt><dd>{project.appliedConfiguration.companySlug ?? '—'}</dd></div>
            <div><dt>Version appliquée</dt><dd>{project.appliedConfiguration.companyVersion ?? '—'}</dd></div>
            <div><dt>Appliquée le</dt><dd>{formatDateTime(project.appliedConfiguration.companyAppliedAt)}</dd></div>
            <div><dt>APIs intégrées reçues</dt><dd>{project.appliedConfiguration.integratedApiCount}</dd></div>
            <div><dt>Constaté le</dt><dd>{formatDateTime(project.appliedConfiguration.observedAt)}</dd></div>
          </dl>
        ) : (
          <EmptyState title="Jamais constatée" hint="Aucune découverte n’a encore relevé ce que le projet applique." />
        )}
      </Card>

      <Card title="Actions techniques">
        <div className="row-actions">
          <Link className="btn btn-secondary btn-small" to={`/supervision/${project.projectId}`}>
            Supervision
          </Link>
          <Link className="btn btn-secondary btn-small" to={`/supervision/${project.projectId}/diagnostic`}>
            Diagnostic
          </Link>
          <Link className="btn btn-secondary btn-small" to={`/supervision/${project.projectId}/actions`}>
            Piloter
          </Link>
          <Link className="btn btn-secondary btn-small" to="/pairings">
            Appairages
          </Link>
        </div>
      </Card>

      {/* Le JSON brut n'est JAMAIS la vue par défaut : la lecture structurée
          ci-dessus répond à presque tout, le brut sert au dernier recours. */}
      <Card title="Manifest brut">
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setRawOpen((o) => !o)}>
          {rawOpen ? 'Masquer le JSON' : 'Afficher le JSON'}
        </button>
        {rawOpen ? (
          project.manifest ? (
            <pre className="error-details">{JSON.stringify(project.manifest, null, 2)}</pre>
          ) : (
            <p className="muted">Aucun manifeste reçu.</p>
          )
        ) : null}
      </Card>
    </>
  );
}

export default ProjectDetailPage;
