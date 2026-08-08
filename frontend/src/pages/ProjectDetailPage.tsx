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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { Disclosure } from '@/components/supervision';
import { ContractCard } from '@/components/ContractCard';
import { EventConfirmation } from '@/components/EventConfirmation';
import { MeetingRow } from '@/components/EventLists';
import { EventTimeline } from '@/components/EventTimeline';
import { MeetingForm, PastEventForm } from '@/components/EventForms';
import { TYPE_LABELS, eventStatusState } from '@/components/eventLabels';
import { Icon } from '@/components/Icon';
import { DernierEtatConnu, FreshnessBanner } from '@/components/FreshnessBanner';
import { LinkChip, LinkRow, lienTelephone, sansProtocole } from '@/components/Links';
import { ThemedFilter } from '@/components/ThemedSelect';
import { useMeetings, useProjectEvents } from '@/lib/useEvents';
import { formatDateTime } from '@/lib/format';
import { useProject, useProjects } from '@/lib/useProjects';
import { useSustained } from '@/lib/useLiveQuery';
import { useIsDev } from '@/auth/RequireDev';
import { getProjectDataFreshness } from '@/lib/projectFreshness';
import { groupProjectsByLogicalProject } from '@/lib/projectConnections';
import { EnvironmentConnectionRow } from '@/components/connections';
import type {
  ProjectDestination, ProjectDestinationsByEnvironment, PublicProject, TeamMember,
} from '@/types';
import type { Meeting, ProjectEvent } from '@/types.events';
import { api, errorMessage } from '@/lib/api';
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
  /**
   * L'ONGLET VIT DANS L'URL — et pas dans un état de composant.
   *
   * ── POURQUOI ─────────────────────────────────────────────────────────────
   * Un lien « gérer la connexion PROD de ce projet » doit ouvrir exactement
   * cela : la bonne fiche, le bon onglet, le bon environnement. Un état de
   * navigation ne survit ni au rafraîchissement, ni au collage d'une URL dans
   * une conversation — c'est-à-dire précisément aux deux usages qu'on veut.
   *
   * `replace` : changer d'onglet n'empile pas une entrée d'historique. Le
   * bouton Retour ramène à la page précédente, pas à l'onglet précédent.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab = tabParam === 'dev' || tabParam === 'events' ? tabParam : 'overview';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(searchParams);
    if (t === 'overview') next.delete('tab');
    else next.set('tab', t);
    setSearchParams(next, { replace: true });
  };
  /** L'environnement mis en avant par le lien profond, s'il y en a un. */
  const envParam = searchParams.get('env');
  const focusEnvironment = envParam === 'TEST' || envParam === 'PROD' ? envParam : null;
  const showRefreshHint = useSustained(isRefreshing, 500);

  if (isInitialLoading) return <div className="page"><p className="muted">Chargement du projet…</p></div>;
  // Après le premier chargement, `error` reste nul tant qu'une fiche est
  // affichable : un rafraîchissement raté ne remplace pas une page lue.
  if (error || !project) {
    return (
      <div className="page">
        <div className="alert alert-error">{error ?? 'Projet introuvable.'}</div>
        <Link className="link-back" to="/projects">
          <Icon name="chevron-down" size={14} />
          Retour aux projets clients
        </Link>
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
  // UNE seule règle de fraîcheur pour toute la fiche : identité, contrat,
  // équipe et document s'y réfèrent, aucun ne décide dans son coin.
  const fraicheur = getProjectDataFreshness(project);

  return (
    <div className="page">
      <p className="breadcrumb">
        {/* Une ACTION de navigation, pas du texte cliquable : ni bleu, ni
            souligné, avec une cible confortable et un focus net. */}
        <Link className="link-back" to="/projects">
          <Icon name="chevron-down" size={14} />
          Projets clients
        </Link>
      </p>

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
            <a
              className="btn btn-secondary btn-small"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="box-arrow-up-right" size={14} />
              Ouvrir le site
            </a>
          ) : null}
        </div>
      </header>

      {/*
        UNE FICHE NE CHANGE PAS D'IDENTITÉ.

        Un contrôle segmenté `[TEST][PROD]` avait été posé ici. Il naviguait
        correctement — mais il donnait à lire l'inverse de ce que le modèle
        dit : une fiche décrit UNE instance, un environnement, une destination,
        un appairage, un état métier. On ne « bascule » pas une fiche d'un monde
        à l'autre ; on ouvre celle de l'autre monde.

        Reste donc un LIEN, discret, qui dit qu'une sœur existe et y mène. La
        fiche courante, elle, ne bouge pas d'un octet.
      */}
      <SisterInstanceLink project={project} />

      {/* AVANT toute donnée métier : ce qui suit est-il encore vrai ? */}
      <FreshnessBanner fraicheur={fraicheur} />

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
        <OverviewTab project={project} url={url} since={since} link={link} fraicheur={fraicheur} />
      ) : null}
      {tab === 'events' ? <EventsTab project={project} /> : null}
      {tab === 'dev' && isDev ? <DeveloperTab project={project} focusEnvironment={focusEnvironment} fraicheur={fraicheur} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * L'AUTRE INSTANCE DU MÊME PRODUIT — un lien, jamais une bascule.
 *
 * ══ CE QU'IL EST, ET CE QU'IL N'EST PAS ═════════════════════════════════════
 *
 * `logicalProjectKey` dit que deux fiches décrivent le même produit. Il ne dit
 * RIEN de leurs données : ni le nom, ni le contrat, ni la destination, ni la
 * protection. Ce lien est donc de la NAVIGATION, et rien d'autre — il mène au
 * `projectId` de la sœur, dont la fiche se chargera seule.
 *
 * C'est ce qui rend structurellement impossible qu'une valeur de PROD
 * apparaisse sur la fiche TEST : ce n'est pas la même page, et `useLiveQuery`
 * change de clé avec le `projectId`.
 *
 * ══ QUAND LA SŒUR N'EXISTE PAS ══════════════════════════════════════════════
 *
 * On ne montre rien. Un projet sans production déclarée est un projet normal,
 * pas un projet incomplet — et l'appairage se propose depuis la page qui sert
 * à cela.
 */
function SisterInstanceLink({ project }: { project: PublicProject }) {
  // Le parc est déjà en cache : les sœurs s'y lisent sans requête.
  const { projects } = useProjects();
  const groupe = useMemo(() => {
    const source = projects.length ? projects : [project];
    const groupes = groupProjectsByLogicalProject(source);
    return (
      groupes.find((g) => g.projects.some((p) => p.projectId === project.projectId))
      ?? groupProjectsByLogicalProject([project])[0]
    );
  }, [projects, project]);

  /** Les sœurs RÉELLES : une autre fiche, un autre environnement. */
  const soeurs = groupe.connections.filter(
    (c) => c.project !== null && c.project.projectId !== project.projectId,
  );
  if (soeurs.length === 0) return null;

  return (
    <p className="sister-instances">
      <span className="sister-label">
        {soeurs.length > 1 ? 'Autres instances de ce produit' : 'Autre instance de ce produit'}
      </span>
      {soeurs.map((c) => (
        <Link key={c.environment} className="sister-link" to={`/projects/${c.project?.projectId}`}>
          {/* Le symbole accompagne le mot : l'état ne se lit jamais à la
              seule couleur. */}
          <span className="sister-env">{c.environment}</span>
          <span className="sister-state">{c.state.symbol} {c.state.label}</span>
        </Link>
      ))}
    </p>
  );
}

function OverviewTab({
  project,
  url,
  since,
  link,
  fraicheur,
}: {
  project: PublicProject;
  url: string | null;
  since: string | null;
  link: { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral' };
  fraicheur: ReturnType<typeof getProjectDataFreshness>;
}) {
  const site = siteState(project);
  /**
   * TROIS DATES, TROIS FAITS DIFFÉRENTS — et elles se lisaient comme une seule.
   *
   *   · `lastContactAt`  — le dernier battement de cœur REÇU par le Panel ;
   *   · `declareParLeProjet` — la date que le PROJET dit être sa dernière
   *     synchronisation. C'est sa parole, transportée par le battement ;
   *   · `lastFullSyncAt` — l'instant où le Panel a réellement APPLIQUÉ une
   *     photographie. C'est le seul des trois qu'il a constaté lui-même.
   *
   * L'écran affichait le deuxième sous le libellé « Dernière mise à jour des
   * informations », juste à côté d'un bandeau qui parlait de « dernière
   * synchronisation complète » — le troisième. Deux nombres différents, deux
   * libellés presque identiques, aucune façon de savoir lequel faisait foi.
   */
  const declareParLeProjet = project.runtime.bridgeStats?.lastSyncAt ?? null;
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
                <LinkChip icon="globe" href={url} external title={url}>
                  {sansProtocole(url)}
                </LinkChip>
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
            <dt>Dernière photographie reçue</dt>
            <dd>
              {fraicheur.lastFullSyncAt
                ? formatDateTime(fraicheur.lastFullSyncAt)
                : <span className="muted">jamais</span>}
            </dd>
          </div>
          <div>
            <dt>Dernière synchronisation déclarée par le projet</dt>
            <dd>
              {declareParLeProjet
                ? formatDateTime(declareParLeProjet)
                : <span className="muted">jamais</span>}
            </dd>
          </div>
        </dl>
      </Card>

      {contacts ? (
        <Card title="Contacts">
          {/* Une présentation commune : icône, libellé, valeur cliquable. Les
              liens nus du navigateur étaient le seul endroit du Panel qui
              ignorait le thème — et débordaient sur mobile. */}
          <div className="link-list">
            {contacts.email ? (
              <LinkRow
                icon="envelope"
                label="E-mail"
                value={contacts.email}
                href={`mailto:${contacts.email}`}
              />
            ) : null}
            {contacts.phone ? (
              <LinkRow
                icon="telephone"
                label="Téléphone"
                value={contacts.phone}
                href={lienTelephone(contacts.phone)}
              />
            ) : null}
            {contacts.website ? (
              <LinkRow
                icon="globe"
                label="Site web"
                value={sansProtocole(contacts.website)}
                href={contacts.website}
                title={contacts.website}
                external
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      {contract ? (
        <ContractCard project={project} contract={contract} />
      ) : (
        <ContractCard project={project} contract={null} />
      )}

      <TeamCard team={project.business?.team ?? []} fraicheur={fraicheur} />

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
/**
 * LES CONNEXIONS DU PROJET — la première chose que l'onglet doit montrer.
 *
 * ── CE QU'IL MONTRAIT ─────────────────────────────────────────────────────
 * Un cadre « Connexion au Panel » listant `pairing.status`, `liveness`,
 * « Curseur de synchronisation », « Outbox » — des noms de champs, au singulier,
 * pour un projet qui a deux environnements. Rien ne disait où était la
 * production, ni comment l'appairer.
 *
 * ── CE QU'IL MONTRE ───────────────────────────────────────────────────────
 * Les deux environnements, leur état, leur domaine, leurs deux horodatages
 * distincts, et l'action qui manque. Le détail technique n'est pas supprimé :
 * il descend d'un cran, dans un repli.
 */
function ConnectionsSection({
  project,
  focusEnvironment,
}: {
  project: PublicProject;
  focusEnvironment: 'TEST' | 'PROD' | null;
}) {
  // Le parc entier est déjà en cache : les sœurs s'y lisent sans requête.
  const { projects, reload } = useProjects();
  const groupe = useMemo(() => {
    const groupes = groupProjectsByLogicalProject(projects.length ? projects : [project]);
    return (
      groupes.find((g) => g.projects.some((p) => p.projectId === project.projectId))
      ?? groupProjectsByLogicalProject([project])[0]
    );
  }, [projects, project]);

  return (
    <Card title="Connexions">
      <p className="muted read-only-note">
        Une fiche du registre décrit UNE instance appairée. Les instances d’un
        même projet sont regroupées par l’identité que le projet annonce
        lui-même — jamais par ressemblance de nom ou de domaine.
      </p>
      <div className="conn-detail-list">
        {groupe.connections.map((c) => (
          <div
            key={c.environment}
            className={
              focusEnvironment === c.environment ? 'conn-focus' : undefined
            }
            /* Le lien profond met en avant l'environnement demandé : on arrive
               SUR la bonne connexion, pas sur une page où il faut la chercher. */
            aria-current={focusEnvironment === c.environment ? 'true' : undefined}
          >
            <EnvironmentConnectionRow connection={c} group={groupe} onChanged={reload} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function DeveloperTab({
  project,
  focusEnvironment,
  fraicheur,
}: {
  project: PublicProject;
  focusEnvironment: 'TEST' | 'PROD' | null;
  /* La fraîcheur est calculée UNE fois, par la fiche, et descend telle quelle.
     La recalculer ici rouvrirait la porte à deux règles divergentes — le
     défaut même que cette règle unique a fermé. */
  fraicheur: ReturnType<typeof getProjectDataFreshness>;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const d = project.descriptor;
  // Les trois adresses sont montrées SÉPARÉMENT : seule celle du site a sa
  // place sur un écran métier, les deux autres restent ici.
  const tech = { site: projectSiteUrl(project), ...projectTechnicalUrls(project) };

  return (
    <>
      <ConnectionsSection project={project} focusEnvironment={focusEnvironment} />

      {/*
        ── LES QUATRE HORODATAGES NE FUSIONNENT JAMAIS ───────────────────────
        Ils décrivent quatre faits différents, et les confondre a déjà coûté un
        écran entier. Chacun dit lequel il est, et de qui il tient son
        information — le Panel, ou le projet.
      */}
      <Card title="Santé de synchronisation">
        {/*
          QUATRE FAITS, QUATRE OUI/NON — et pas une chaîne de génération.
          Le diagnostic détaillé vit un cran plus bas ; ici on répond à « est-ce
          que ça va ? » sans obliger à lire une clé composite.
        */}
        <ul className="sync-health">
          <li className={fraicheur.connection === 'ONLINE' ? 'sync-ok' : 'sync-ko'}>
            <span aria-hidden="true">{fraicheur.connection === 'ONLINE' ? '●' : '○'}</span>
            {fraicheur.connection === 'ONLINE' ? 'Connecté' : 'Pas de contact récent'}
          </li>
          <li className={fraicheur.lastFullSyncAt ? 'sync-ok' : 'sync-ko'}>
            <span aria-hidden="true">{fraicheur.lastFullSyncAt ? '●' : '○'}</span>
            {fraicheur.lastFullSyncAt ? 'Photographie reçue' : 'Aucune photographie reçue'}
          </li>
          <li className={fraicheur.isGenerationMismatch ? 'sync-ko' : 'sync-ok'}>
            <span aria-hidden="true">{fraicheur.isGenerationMismatch ? '○' : '●'}</span>
            {fraicheur.isGenerationMismatch
              ? 'Photographie d’une autre instance'
              : 'Génération cohérente'}
          </li>
          <li className={project.business?.freshness?.destinationKnown === false ? 'sync-ko' : 'sync-ok'}>
            <span aria-hidden="true">
              {project.business?.freshness?.destinationKnown === false ? '○' : '●'}
            </span>
            {project.business?.freshness?.destinationKnown === false
              ? 'Destination inconnue du calcul'
              : 'Destination connue'}
          </li>
        </ul>
      </Card>

      <Disclosure title="Informations techniques" hint="Identifiants, horodatages, générations et destinations.">
        <Card title="Cette instance">
          <dl className="detail-list">
            <div><dt>Environnement</dt><dd>{project.environment ?? '—'}</dd></div>
            <div><dt>Identité logique</dt><dd>
              {project.logicalProjectKey
                ? <code className="inline-code">{project.logicalProjectKey}</code>
                : <span className="muted">aucune — fiche seule de son groupe</span>}
            </dd></div>
            <div><dt>Clé technique de la fiche</dt><dd><code className="inline-code">{project.projectKey}</code></dd></div>
            <div><dt>Appairage</dt><dd>{project.pairing.status}</dd></div>
            <div><dt>Appairé le</dt><dd>{formatDateTime(project.pairing.pairedAt)}</dd></div>
            <div><dt>Révoqué le</dt><dd>{formatDateTime(project.pairing.revokedAt)}</dd></div>
            <div><dt>Vivacité</dt><dd>{project.liveness}</dd></div>
          </dl>
        </Card>

        <Card title="Horodatages — quatre faits distincts">
          <dl className="detail-list">
            <div>
              <dt>Dernier contact <span className="dt-source">observé par le Panel</span></dt>
              <dd>
                {formatDateTime(project.runtime.lastHeartbeatAt)}
                {project.secondsSinceLastHeartbeat !== null
                  ? ` (${project.secondsSinceLastHeartbeat} s)`
                  : ''}
              </dd>
            </div>
            <div>
              <dt>Dernière photographie reçue <span className="dt-source">appliquée par le Panel</span></dt>
              <dd>{fraicheur.lastFullSyncAt ? formatDateTime(fraicheur.lastFullSyncAt) : '—'}</dd>
            </div>
            <div>
              <dt>Synchronisation déclarée <span className="dt-source">affirmée par le projet</span></dt>
              <dd>{project.runtime.bridgeStats?.lastSyncAt ?? '—'}</dd>
            </div>
            <div>
              <dt>File d’attente du projet</dt>
              <dd>{project.runtime.bridgeStats?.outboxSize ?? '—'}</dd>
            </div>
          </dl>
        </Card>

        <Card title="Génération et fraîcheur">
          <dl className="detail-list">
            <div><dt>Environnement de la photographie</dt><dd>{fraicheur.projectionEnvironment ?? '—'}</dd></div>
            <div><dt>Environnement déclaré aujourd’hui</dt><dd>{fraicheur.runtimeEnvironment ?? '—'}</dd></div>
            <div><dt>Génération de la photographie</dt><dd><code className="inline-code">{project.business?.freshness?.projectionGeneration ?? '—'}</code></dd></div>
            <div><dt>Génération courante</dt><dd><code className="inline-code">{project.business?.freshness?.runtimeGeneration ?? '—'}</code></dd></div>
            <div><dt>Rupture de génération</dt><dd>{fraicheur.isGenerationMismatch ? 'oui' : 'non'}</dd></div>
            <div><dt>Rupture d’environnement</dt><dd>{fraicheur.isEnvironmentMismatch ? 'oui' : 'non'}</dd></div>
            <div><dt>Destination connue du calcul</dt><dd>
              {project.business?.freshness?.destinationKnown === false ? 'non' : 'oui'}
            </dd></div>
          </dl>
        </Card>

        <DestinationsCard projectId={project.projectId} />

      <Card title="Fiche technique du projet">
        <dl className="detail-list">
          <div><dt>Identifiant technique</dt><dd><code className="inline-code">{project.projectKey}</code></dd></div>
          <div><dt>URL du site</dt><dd>{tech.site ?? '—'}</dd></div>
          <div><dt>URL du Manager</dt><dd>{tech.manager ?? '—'}</dd></div>
          {/*
            AUCUN REPLI sur `runtime.publicBackendUrl` : cette adresse est
            posée au bootstrap et jamais revue. L'afficher en secours faisait
            resurgir l'ancien domaine dès que la destination était incomplète —
            et il ressemblait alors à une donnée à jour.
          */}
          <div><dt>URL du backend</dt><dd>{tech.backend ?? '—'}</dd></div>
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
      </Disclosure>

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
function TeamCard({
  team,
  fraicheur,
}: {
  team: TeamMember[];
  fraicheur: ReturnType<typeof getProjectDataFreshness>;
}) {
  // Une équipe reçue d'un AUTRE environnement n'est pas l'équipe actuelle :
  // ce sont des personnes qui n'ont peut-être aucun compte sur cette instance.
  const perimee = !fraicheur.isBusinessDataFresh;
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
      {perimee ? (
        <p className="muted">
          <DernierEtatConnu fraicheur={fraicheur} attente="Équipe actuelle : en attente de synchronisation">
            {`${team.length} utilisateur${team.length > 1 ? 's' : ''}`}
          </DernierEtatConnu>
        </p>
      ) : null}
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
        <div className="filter-row">
          <ThemedFilter
            label="Type"
            value={filtreType}
            placeholder="Tous les types"
            onChange={setFiltreType}
            options={[
              { value: '', label: 'Tous les types' },
              ...Object.entries(TYPE_LABELS).map(([k, v]) => ({ value: k, label: v })),
            ]}
          />
          <ThemedFilter
            label="État"
            value={filtreStatut}
            placeholder="Tous les états"
            onChange={setFiltreStatut}
            options={[
              { value: '', label: 'Tous les états' },
              ...['CONFIRMED', 'MISSED', 'CANCELLED'].map((s) => ({
                value: s,
                label: eventStatusState(s as never).label,
              })),
            ]}
          />
        </div>
        {historique.length === 0 ? (
          <p className="muted">Rien n’a encore été consigné pour ce client.</p>
        ) : (
          // La chronologie remplace la liste : compacte, dépliable au clic.
          // Les notes internes ne s'affichent qu'une fois l'entrée ouverte.
          <EventTimeline events={historique} onEdit={setEvenementEdite} />
        )}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  DESTINATIONS — UNE PAR ENVIRONNEMENT, ET AUCUN BOUTON DE DÉPLOIEMENT      */
/* -------------------------------------------------------------------------- */

/**
 * OÙ VIT CE PROJET — la vérité du Panel, environnement par environnement.
 *
 * ══ POURQUOI IL N'Y A NI « DÉPLOYER », NI « REDÉPLOYER », NI « MIGRER » ═════
 *
 * Le déploiement est piloté depuis le poste du projet. Le Panel ne déploie
 * jamais : il ENREGISTRE ce que le projet lui annonce et arbitre les états.
 * Ajouter ici un bouton qui déclenche un déploiement ferait du Panel un second
 * moteur — et deux moteurs finissent toujours par se contredire.
 *
 * Les deux seules actions humaines sont donc : constater qu'une destination
 * RETIRÉE ne contient plus rien, puis supprimer sa fiche. Le Panel ne vérifie
 * pas ce constat : il ne se connecte à aucun serveur de projet.
 *
 * Les destinations sont chargées une fois, pas sondées : elles ne changent
 * qu'au rythme des déménagements.
 */
function DestinationsCard({ projectId }: { projectId: string }) {
  const isDev = useIsDev();
  const [parEnv, setParEnv] = useState<ProjectDestinationsByEnvironment | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const charger = useCallback(async () => {
    try {
      setParEnv((await api.getProject(projectId)).destinations ?? null);
      setErreur(null);
    } catch (err) {
      setErreur(errorMessage(err, 'Destinations indisponibles.'));
    }
  }, [projectId]);

  useEffect(() => { void charger(); }, [charger]);

  const agir = async (action: () => Promise<unknown>) => {
    setOccupe(true);
    setErreur(null);
    try {
      await action();
      await charger();
    } catch (err) {
      setErreur(errorMessage(err, 'Action refusée.'));
    } finally {
      setOccupe(false);
    }
  };

  if (!parEnv) {
    return (
      <Card title="Destinations">
        <p className="muted">{erreur ?? 'Chargement…'}</p>
      </Card>
    );
  }

  return (
    <Card title="Destinations">
      <p className="muted read-only-note">
        Le Panel n’effectue aucun déploiement : ces destinations sont ce que le
        projet lui a ANNONCÉ depuis son propre poste. Un changement de domaine
        se déclenche là-bas, et la bascule n’a lieu ici qu’une fois la
        photographie complète reçue.
      </p>

      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      {(['TEST', 'PROD'] as const).map((env) => {
        const bloc = parEnv[env];
        return (
          <section key={env} className="destination-env">
            <h3 className="section-title">{env}</h3>

            {bloc.active ? (
              <DestinationRow d={bloc.active} occupe={occupe} isDev={isDev} onAgir={agir} />
            ) : (
              <p className="muted">
                Aucune destination active. Le Panel ne sait pas où vit ce projet
                dans cet environnement — et n’affichera aucune adresse plutôt
                qu’une adresse périmée.
              </p>
            )}

            {bloc.pending ? (
              <div className="alert alert-warning">
                <strong>Migration annoncée vers {bloc.pending.host}.</strong> La
                bascule attend la photographie complète
                {bloc.pending.missing.length
                  ? ` — il manque : ${bloc.pending.missing.join(', ')}.`
                  : '.'}
              </div>
            ) : null}

            {bloc.history.length > 0 ? (
              <Disclosure title={`Historique (${bloc.history.length})`}>
                {bloc.history.map((d) => (
                  <DestinationRow key={d.destinationId} d={d} occupe={occupe} isDev={isDev} onAgir={agir} />
                ))}
              </Disclosure>
            ) : null}
          </section>
        );
      })}
    </Card>
  );
}

/** Une destination, avec les seules actions que le backend autorise. */
function DestinationRow({ d, occupe, isDev, onAgir }: {
  d: ProjectDestination;
  occupe: boolean;
  isDev: boolean;
  onAgir: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const libelle: Record<string, { texte: string; ton: string }> = {
    PENDING: { texte: 'Annoncée — en attente', ton: 'warn' },
    ACTIVE: { texte: 'Active', ton: 'ok' },
    RETIRED: { texte: 'Retirée', ton: 'neutral' },
    EMPTY: { texte: 'Vidée', ton: 'neutral' },
    DELETED: { texte: 'Supprimée', ton: 'muted' },
  };
  const etat = libelle[d.status] ?? { texte: d.status, ton: 'neutral' };

  return (
    <div className="destination-row">
      <div className="destination-head">
        <code className="inline-code">{d.host}</code>
        <span className={`badge badge-${etat.ton}`}>{etat.texte}</span>
        {d.announcedBy ? <span className="muted">annoncée par {d.announcedBy}</span> : null}
      </div>
      <dl className="detail-list">
        <div><dt>Site</dt><dd>{d.urls.website ?? '—'}</dd></div>
        <div><dt>Manager</dt><dd>{d.urls.manager ?? '—'}</dd></div>
        <div><dt>Backend</dt><dd>{d.urls.backend ?? '—'}</dd></div>
        <div><dt>Annoncée le</dt><dd>{formatDateTime(d.announcedAt)}</dd></div>
        {d.activatedAt ? <div><dt>Active depuis</dt><dd>{formatDateTime(d.activatedAt)}</dd></div> : null}
        {d.retiredAt ? <div><dt>Retirée le</dt><dd>{formatDateTime(d.retiredAt)}</dd></div> : null}
      </dl>

      {isDev && (d.canMarkEmpty || d.canDelete) ? (
        <div className="action-buttons">
          {d.canMarkEmpty ? (
            <button
              type="button" className="btn btn-small" disabled={occupe}
              title="Déclare qu’il ne reste plus rien sur le serveur. Le Panel ne le vérifie pas : il ne s’y connecte pas."
              onClick={() => void onAgir(() => api.markDestinationEmpty(d.destinationId))}
            >
              Déclarer vide
            </button>
          ) : null}
          {d.canDelete ? (
            <button
              type="button" className="btn btn-small btn-danger" disabled={occupe}
              title="Retire la fiche des listes. Audit et historique conservés."
              onClick={() => void onAgir(() => api.deleteDestination(d.destinationId))}
            >
              Supprimer la destination
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}