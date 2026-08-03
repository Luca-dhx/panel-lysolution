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
 * Le contrat est affiché depuis qu'il remonte des sites. « Factures » et
 * « Réunions » restent absents : ces données ne remontent pas encore, et un
 * cadre vide se lirait comme « ce client n'a pas de facture », ce qui serait
 * faux.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { ContractCard } from '@/components/ContractCard';
import { EventConfirmation } from '@/components/EventConfirmation';
import { EventRow, MeetingRow } from '@/components/EventLists';
import { MeetingForm, PastEventForm } from '@/components/EventForms';
import { TYPE_LABELS, eventStatusState } from '@/components/eventLabels';
import { useMeetings, useProjectEvents } from '@/lib/useEvents';
import { formatDateTime } from '@/lib/format';
import { useProject } from '@/lib/useProjects';
import { useSustained } from '@/lib/useLiveQuery';
import { useIsDev } from '@/auth/RequireDev';
import type { PublicProject, TeamMember } from '@/types';
import type { Meeting, ProjectEvent } from '@/types.events';
import { api } from '@/lib/api';
import {
  connectionState,
  isBusinessSynchronized,
  lastContact,
  linkState,
  projectAlert,
  projectDescription,
  projectDisplayName,
  projectContacts,
  projectInitials,
  projectLogoUrl,
  projectTechnicalUrls,
  projectSiteUrl,
  siteState,
  toneBadgeClass,
} from '@/lib/projectPresentation';

type Tab = 'overview' | 'events' | 'dev';

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const isDev = useIsDev();
  /**
   * La fiche est VIVANTE : une modification faite dans le Manager du client
   * apparaît ici sans clic, comme dans la liste. Le rafraîchissement est
   * silencieux — l'onglet actif, le défilement et les états locaux ci-dessous
   * survivent, puisque le composant n'est jamais démonté entre deux réponses.
   */
  const { project, isInitialLoading, isRefreshing, error } = useProject(projectId);
  const [tab, setTab] = useState<Tab>('overview');
  const showRefreshHint = useSustained(isRefreshing, 500);

  if (isInitialLoading) return <div className="page"><p className="muted">Chargement du projet…</p></div>;
  // Après le premier chargement, `error` reste nul tant qu'une fiche est
  // affichable : un rafraîchissement raté ne remplace pas une page lue.
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
          {projectLogoUrl(project) ? (
            <img className="project-avatar" src={projectLogoUrl(project) as string} alt="" />
          ) : (
            <span className="project-avatar">{projectInitials(project)}</span>
          )}
          <div className="project-row-main">
            <h1>{projectDisplayName(project)}</h1>
            {description ? (
              <p className="page-description">
                {description}
                {showRefreshHint ? <span className="live-hint">Mise à jour…</span> : null}
              </p>
            ) : null}
            <div className="project-row-meta">
              <span className={toneBadgeClass(site.tone)}>{site.label}</span>
              <span className={toneBadgeClass(connection.tone)}>{connection.label}</span>
              {project.pairing.status === 'PAIRED' && !isBusinessSynchronized(project) ? (
                <span className={toneBadgeClass('warn')}>Identité non synchronisée</span>
              ) : null}
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
        <button
          type="button"
          className={tab === 'events' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('events')}
        >
          Événements
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
      {tab === 'events' ? <EventsTab project={project} /> : null}
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
  const contacts = projectContacts(project);
  const contract = project.business?.contract ?? null;

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

      {contacts ? (
        <Card title="Contacts">
          <dl className="detail-list">
            {contacts.email ? (
              <div>
                <dt>E-mail</dt>
                <dd><a href={`mailto:${contacts.email}`}>{contacts.email}</a></dd>
              </div>
            ) : null}
            {contacts.phone ? (
              <div>
                <dt>Téléphone</dt>
                <dd><a href={`tel:${contacts.phone.replace(/\s+/g, '')}`}>{contacts.phone}</a></dd>
              </div>
            ) : null}
            {contacts.website ? (
              <div>
                <dt>Site web</dt>
                <dd>
                  <a href={contacts.website} target="_blank" rel="noreferrer">
                    {contacts.website.replace(/^[a-z]+:\/\//, '')}
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>
      ) : null}

      {contract ? (
        <ContractCard project={project} contract={contract} />
      ) : (
        <ContractCard project={project} contract={null} />
      )}

      <TeamCard team={project.business?.team ?? []} />

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
        Les factures, les rendez-vous et l’historique des échanges ne sont pas encore remontés
        depuis le site : ils apparaîtront ici une fois leur synchronisation en place.
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
  // Les trois adresses sont montrées SÉPARÉMENT : seule celle du site a sa
  // place sur un écran métier, les deux autres restent ici.
  const tech = { site: projectSiteUrl(project), ...projectTechnicalUrls(project) };

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
          <div><dt>URL du site</dt><dd>{tech.site ?? '—'}</dd></div>
          <div><dt>URL du Manager</dt><dd>{tech.manager ?? '—'}</dd></div>
          <div><dt>URL du backend</dt><dd>{tech.backend ?? project.runtime.publicBackendUrl ?? '—'}</dd></div>
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


/* -------------------------------------------------------------------------- */

/**
 * ÉQUIPE DU PROJET — en LECTURE SEULE.
 *
 * Ces comptes appartiennent au projet. Le Panel les affiche pour savoir à qui
 * l'on parle ; il n'en crée, n'en modifie et n'en supprime aucun. Aucune
 * action de gestion à distance n'est proposée, et ce n'est pas un oubli.
 *
 * Ni « dernière connexion » ni « statut actif » : le projet ne tient pas ces
 * informations. Afficher une colonne vide serait moins honnête que ne pas
 * l'afficher du tout.
 */
function TeamCard({ team }: { team: TeamMember[] }) {
  if (team.length === 0) {
    return (
      <Card title="Équipe du projet">
        <p className="muted">
          Aucun compte synchronisé. L’équipe remonte automatiquement dès que le projet la publie.
        </p>
      </Card>
    );
  }

  const initiales = (m: TeamMember) => {
    const base = (m.name || m.email).trim();
    const mots = base.split(/[\s@.]+/).filter(Boolean);
    return (mots[0]?.[0] ?? '?').toUpperCase() + (mots[1]?.[0] ?? '').toUpperCase();
  };

  return (
    <Card title="Équipe du projet">
      <ul className="team-list">
        {team.map((m) => (
          <li key={m.entityId} className="team-row">
            <span className="project-avatar project-avatar-small">{initiales(m)}</span>
            <span className="team-row-main">
              <span className="team-row-name">{m.name || m.email}</span>
              <span className="muted">{m.email}</span>
            </span>
            <span className="badge badge-muted">{m.role}</span>
          </li>
        ))}
      </ul>
      <p className="muted">
        Ces comptes appartiennent au projet : ils se gèrent dans son Manager, pas ici.
      </p>
    </Card>
  );
}


/* -------------------------------------------------------------------------- */

/**
 * ÉVÉNEMENTS DU PROJET — prochain, à confirmer, historique.
 *
 * Ces rendez-vous appartiennent au Panel. Le client n'en reçoit rien : ce sont
 * nos notes de suivi, pas les siennes.
 */
/**
 * ONGLET ÉVÉNEMENTS — l'histoire de CE client, et rien d'autre.
 *
 * Toutes les lectures sont bornées au projet courant. Afficher, même par
 * accident, un rendez-vous pris avec un autre client serait une fuite : ces
 * notes sont internes, mais elles nomment des tiers.
 *
 * Réunions et événements restent séparés à l'écran, comme dans le modèle.
 */
function EventsTab({ project }: { project: PublicProject }) {
  const projectId = project.projectId;
  const nom = projectDisplayName(project);
  const { summary, isInitialLoading, reload } = useProjectEvents(projectId);
  const { meetings, reload: rechargerReunions } = useMeetings('upcoming', projectId);
  const [volet, setVolet] = useState<null | 'reunion' | 'evenement'>(null);
  // Édition : on rouvre le MÊME formulaire, pré-rempli. Un écran d'édition
  // séparé aurait dupliqué chaque champ et chaque validation.
  const [reunionEditee, setReunionEditee] = useState<Meeting | null>(null);
  const [evenementEdite, setEvenementEdite] = useState<ProjectEvent | null>(null);
  const [filtreType, setFiltreType] = useState('');
  const [filtreStatut, setFiltreStatut] = useState('');

  const toutRecharger = () => { void reload(); void rechargerReunions(); };

  if (isInitialLoading) {
    return <Card title="Événements"><p className="muted">Chargement…</p></Card>;
  }

  const enAttente = summary?.pending ?? [];
  const historique = (summary?.history ?? []).filter(
    (e) => (!filtreType || e.type === filtreType) && (!filtreStatut || e.status === filtreStatut),
  );

  return (
    <>
      <div className="contract-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={() => setVolet('reunion')}>
          Planifier une réunion
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setVolet('evenement')}>
          Ajouter un événement passé
        </button>
      </div>

      {volet === 'reunion' || reunionEditee ? (
        <MeetingForm
          projectId={projectId}
          projectName={nom}
          meeting={reunionEditee ?? undefined}
          onSaved={() => { setVolet(null); setReunionEditee(null); toutRecharger(); }}
          onCancel={() => { setVolet(null); setReunionEditee(null); }}
        />
      ) : null}
      {volet === 'evenement' || evenementEdite ? (
        <PastEventForm
          projectId={projectId}
          projectName={nom}
          event={evenementEdite ?? undefined}
          onSaved={() => { setVolet(null); setEvenementEdite(null); toutRecharger(); }}
          onCancel={() => { setVolet(null); setEvenementEdite(null); }}
        />
      ) : null}

      {enAttente.length > 0 ? (
        <Card title={`À confirmer (${enAttente.length})`}>
          {enAttente.map((e) => (
            <EventConfirmation key={e._id} event={e} onResolved={toutRecharger} />
          ))}
        </Card>
      ) : null}

      <Card title="Réunions à venir">
        {meetings.length === 0 ? (
          <p className="muted">Aucune réunion prévue avec ce client.</p>
        ) : (
          <ul className="event-list">
            {meetings.map((m) => (
              <MeetingRow
                key={m._id}
                meeting={m}
                showProject={false}
                onEdit={setReunionEditee}
                onCancel={(r) => void api.cancelMeeting(r._id).then(toutRecharger)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Historique">
        <div className="contract-actions">
          <select value={filtreType} onChange={(e) => setFiltreType(e.target.value)}>
            <option value="">Tous les types</option>
            {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={filtreStatut} onChange={(e) => setFiltreStatut(e.target.value)}>
            <option value="">Tous les états</option>
            {['CONFIRMED', 'MISSED', 'CANCELLED'].map((s) => (
              <option key={s} value={s}>{eventStatusState(s as never).label}</option>
            ))}
          </select>
        </div>
        {historique.length === 0 ? (
          <p className="muted">Rien n’a encore été consigné pour ce client.</p>
        ) : (
          <ul className="event-list">
            {historique.map((e) => (
              <EventRow key={e._id} event={e} showProject={false} onEdit={setEvenementEdite} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
