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
import { FinanceWorkspace } from '@/components/finance/FinanceWorkspace';
import { MeetingForm, PastEventForm } from '@/components/EventForms';
import { TYPE_LABELS, eventStatusState } from '@/components/eventLabels';
import { Icon } from '@/components/Icon';
import { FreshnessBanner } from '@/components/FreshnessBanner';
import { ProjectClientCompanyCard } from '@/components/company/ProjectClientCompanyCard';
import { ProjectLegalSection } from '@/components/legal/ProjectLegalSection';
import { LinkChip, LinkRow, lienTelephone, sansProtocole } from '@/components/Links';
import { ThemedFilter } from '@/components/ThemedSelect';
import { useMeetings, useProjectEvents } from '@/lib/useEvents';
import { formatDateTime } from '@/lib/format';
import { useProject, useProjects } from '@/lib/useProjects';
import { useSustained } from '@/lib/useLiveQuery';
import { useIsDev } from '@/auth/RequireDev';
import { getProjectDataFreshness } from '@/lib/projectFreshness';
import { toPairingRow } from '@/lib/projectConnections';
import { ConnectionStatusDot } from '@/components/connections';
import { ConnectionActions } from '@/components/ConnectionActions';
import { DeadLettersCard } from '@/components/DeadLettersCard';
import type {
  ProjectAccountView, ProjectAccountsRead,
  ProjectDestination, ProjectDestinationsByEnvironment, PublicProject,
} from '@/types';
import type { Meeting, ProjectEvent } from '@/types.events';
import { api, integratedApis, errorMessage } from '@/lib/api';
import type { CapabilityView } from '@/types.integratedApi';
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
  vitrineState,
  vitrineSuspensionReason,
  toneBadgeClass,
} from '@/lib/projectPresentation';

type Tab = 'overview' | 'events' | 'finances' | 'dev';

/** Les onglets atteignables par l'URL — la garde DEV reste séparée. */
const TABS: Tab[] = ['overview', 'events', 'finances', 'dev'];

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const isDev = useIsDev();
  /**
   * La fiche est VIVANTE : une modification faite dans le Manager du client
   * apparaît ici sans clic, comme dans la liste. Le rafraîchissement est
   * silencieux — l'onglet actif, le défilement et les états locaux ci-dessous
   * survivent, puisque le composant n'est jamais démonté entre deux réponses.
   */
  const { project, isInitialLoading, isRefreshing, error, reload } = useProject(projectId);
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
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'overview';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(searchParams);
    if (t === 'overview') next.delete('tab');
    else next.set('tab', t);
    setSearchParams(next, { replace: true });
  };
  /*
    `?env=TEST` A DISPARU DE CETTE PAGE.
    Il servait à mettre en avant l'une des deux lignes d'une fiche qui en
    portait deux. Une fiche n'en porte plus qu'une : il n'y a plus rien à
    désigner, et un paramètre qui ne désigne rien finit par mentir.
  */
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

  /**
   * DEUX FAITS, DEUX PASTILLES — et elles ne disent plus la même chose.
   *
   * L'en-tête montrait `siteState` (le battement du pont) à côté de
   * `connectionState` (la fraîcheur de ce même battement) : deux pastilles pour
   * une seule information, et aucune sur la vitrine. On montre désormais
   * l'accessibilité du site à côté de l'état du lien.
   */
  const site = vitrineState(project);
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
        UNE FICHE = UNE INSTANCE. RIEN NE MÈNE AILLEURS DEPUIS ICI.

        Deux constructions sont passées par cet emplacement, et toutes deux
        sont parties :

          · un contrôle segmenté `[TEST][PROD]`, qui donnait à lire l'inverse
            du modèle — on ne « bascule » pas une fiche d'un monde à l'autre ;
          · puis un lien « Autre instance de ce produit », dérivé de
            `logicalProjectKey`.

        Le second était plus honnête, mais reposait sur une situation qui ne
        peut pas exister : un Panel ne sert qu'un environnement, et l'appairage
        refuse l'autre. La « sœur » affichée n'était jamais qu'une fiche
        fantôme, jamais appairée.
      */}

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
        {/*
          FINANCES — visible par tout compte du Panel, comme la vue d'ensemble.
          Le backend applique la même règle : cet onglet ne masque rien qu'une
          URL révélerait, il reflète une permission qui existe côté serveur.
        */}
        <button
          type="button"
          className={tab === 'finances' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('finances')}
        >
          Finances
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
        <OverviewTab project={project} url={url} since={since} link={link} fraicheur={fraicheur}
          onClientCompanyChanged={reload} />
      ) : null}
      {tab === 'events' ? <EventsTab project={project} /> : null}
      {/*
        LE MÊME MOTEUR QUE LA PAGE GLOBALE, avec le rattachement VERROUILLÉ.
        Rien n'est recopié : un second calcul de bénéfice aurait fini par
        afficher un autre chiffre que celui de la page Finances, pour les mêmes
        lignes.
      */}
      {tab === 'finances' ? (
        <FinanceWorkspace
          scope="project"
          projectId={project.projectId}
          projectName={projectDisplayName(project)}
        />
      ) : null}
      {tab === 'dev' && isDev ? <DeveloperTab project={project} fraicheur={fraicheur} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function OverviewTab({
  project,
  url,
  since,
  link,
  fraicheur,
  onClientCompanyChanged,
}: {
  project: PublicProject;
  url: string | null;
  since: string | null;
  link: { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral' };
  fraicheur: ReturnType<typeof getProjectDataFreshness>;
  /** Recharge la fiche après un rattachement : le verdict en dépend. */
  onClientCompanyChanged: () => void;
}) {
  // `useIsDev()` a disparu d'ici avec la carte d'ouverture commerciale : elle
  // était le seul geste de cette section réservé aux comptes DEV.
  const site = vitrineState(project);
  const causeSuspension = vitrineSuspensionReason(project);
  const siteStatus = project.business?.siteStatus ?? null;
  // La connexion au projet est calculée ICI : la carte l'affiche à côté de la
  // vitrine, et les deux doivent pouvoir se contredire sans se confondre.
  const connection = connectionState(project);
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
      {/*
        ── À QUI FACTURE-T-ON CE SITE ? ─────────────────────────────────

        ══ POURQUOI CETTE CARTE VIENT EN PREMIER ═══════════════════════

        Parce que sans elle, ce projet ne peut ni encaisser ni faire
        signer — et que rien d’autre sur cet écran ne le dit. L’état du
        site, la connexion, le contrat : tout peut être au vert pendant
        que le premier paiement est refusé faute de client légal.

        L’identité elle-même n’est pas recopiée ici : un lien vers la fiche
        « Clients » vaut mieux qu’une copie qui vieillirait.
      */}
      <ProjectClientCompanyCard project={project} onChanged={onClientCompanyChanged} />

      {/*
        ── LES DOCUMENTS LÉGAUX, JUSTE APRÈS L'ENTREPRISE CLIENTE ───────────

        L'ordre n'est pas indifférent : les mentions légales NOMMENT
        l'entreprise cliente. Les placer avant elle ferait découvrir
        l'avertissement « information non renseignée » avant d'avoir vu la
        fiche qui le répare.

        La section charge ses données SÉPARÉMENT de la fiche (`GET
        /legal-documents`). Elle coûte la résolution des deux documents, et la
        joindre à `detail` la ferait payer à chaque ouverture de fiche — y
        compris pour lire un heartbeat.
      */}
      <ProjectLegalSection projectId={project.projectId} />

      <Card title="Le site">
        <dl className="detail-list">
          {/*
            ── DEUX LIGNES, PARCE QUE CE SONT DEUX FAITS ────────────────────

            ══ CE QUE CETTE CARTE DISAIT, ET POURQUOI C'ÉTAIT FAUX ══════════

            Une seule ligne, « État du site : En ligne », alimentée par le
            battement de cœur du Bridge. Une vitrine SUSPENDUE par la
            protection contractuelle — donc inaccessible à ses visiteurs — s'y
            affichait « En ligne » dès lors que son backend répondait
            normalement. L'écran disait l'exact contraire du réel.

            « Le projet me parle » et « le site est accessible » sont deux
            questions. Elles ont maintenant chacune leur ligne, et chacune sa
            source : le battement pour la première, la projection
            PROJECT_SITE_STATUS pour la seconde.
          */}
          <div>
            <dt>Connexion projet</dt>
            <dd><span className={toneBadgeClass(connection.tone)}>{connection.label}</span></dd>
          </div>
          <div>
            <dt>Vitrine</dt>
            <dd>
              <span className={toneBadgeClass(site.tone)}>{site.label}</span>
              {/*
                LA CAUSE ACCOMPAGNE LA SUSPENSION — nommée par sa source.
                Une maintenance technique n'est pas un fait contractuel :
                chercher un problème de contrat devant une maintenance ferait
                perdre exactement le temps que cette ligne fait gagner.
              */}
              {causeSuspension ? (
                <span className="muted"> — {causeSuspension}</span>
              ) : null}
              {/*
                DEPUIS QUAND ON LE SAIT. Une projection reçue avant une coupure
                reste la dernière vérité connue : la dater évite de la prendre
                pour un constat de l'instant.
              */}
              {siteStatus?.receivedAt ? (
                <div className="muted">Reçu le {formatDateTime(siteStatus.receivedAt)}</div>
              ) : null}
            </dd>
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
          {/*
            DEUX FAITS, ET ILS NE SE DÉDUISENT PAS L'UN DE L'AUTRE.

            Au-dessus : « cette instance répond-elle ? ». Ici : « quand le
            Panel a-t-il reçu son état métier ? ». Un projet dont l'entreprise
            ne change jamais bat toutes les trente secondes sans rien projeter
            — sa fiche est vivante ET n'a jamais rien reçu. Les deux lignes
            doivent pouvoir le dire ensemble.
          */}
          <div>
            <dt>Données métier</dt>
            <dd>
              {fraicheur.businessDataEverReceived ? (
                <>
                  {/* Le symbole accompagne le mot : l'état ne se lit jamais à
                      la seule couleur. */}
                  <span className="badge-ok">✓ reçues</span>
                  {' '}
                  <span className="muted">
                    {formatDateTime(fraicheur.lastBusinessSyncAt)}
                  </span>
                </>
              ) : (
                /*
                  « JAMAIS REÇUES » N'EST PAS « À JOUR », ET PAS DAVANTAGE UNE
                  PANNE : un projet qui n'a rien à dire n'a rien projeté. On
                  l'écrit tel quel, sans diagnostic inventé.
                */
                <span className="muted">jamais reçues</span>
              )}
            </dd>
          </div>
          {/*
            LA LIVRAISON EST-ELLE BLOQUÉE ? — le troisième fait, et il manquait.

            ══ CE QUE CET ÉCRAN LAISSAIT CROIRE ═══════════════════════════════

            « ● Connecté » et une date de données métier ancienne : les deux
            lignes étaient justes, et personne ne pouvait les relier. Une
            instance dont TOUTES les écritures étaient refusées par le contrat
            battait parfaitement et n'avait plus rien livré depuis des
            semaines. L'opérateur en concluait, très raisonnablement, que « la
            synchronisation est lente » — alors qu'elle était arrêtée.

            La ligne n'apparaît QUE lorsqu'il y a quelque chose à dire : une
            fiche saine ne gagne pas un champ de plus. Le détail technique
            reste court ; le reste vit dans l'onglet développeur.
          */}
          {project.businessSync?.status === 'BLOCKED' && (
            <div>
              <dt>Livraison</dt>
              <dd>
                <span className="badge badge-warn">⚠ bloquée</span>
                {' '}
                <span className="muted">
                  {project.businessSync.blocked?.entityType
                    ? `${project.businessSync.blocked.entityType} refusé`
                    : `${project.businessSync.rejectedCount} écriture(s) refusée(s)`}
                  {project.businessSync.blocked?.since
                    ? ` depuis le ${formatDateTime(project.businessSync.blocked.since)}`
                    : ''}
                </span>
              </dd>
            </div>
          )}
          <div>
            <dt>Dernière modification annoncée par le projet</dt>
            <dd>
              {declareParLeProjet
                ? formatDateTime(declareParLeProjet)
                : <span className="muted">jamais</span>}
            </dd>
          </div>
        </dl>
      </Card>

      {/*
        ── LA CARTE « OUVERTURE COMMERCIALE » A ÉTÉ SUPPRIMÉE ────────────────
        Elle portait deux badges (PRÉ-OUVERTURE / OUVERTE), la liste des
        contrôles préalables, et le bouton réservé aux DEV qui basculait
        l'instance. Un projet appairé et configuré agit désormais sans ce
        geste : il n'y a plus d'état à lire, donc plus rien à afficher ici.
      */}

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

      <ProjectAccountsCard projectId={project.projectId} />

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
 * LA CONNEXION DE CETTE FICHE — une, et une seule.
 *
 * ══ CE QUE CE CADRE MONTRAIT ════════════════════════════════════════════════
 *
 * Deux lignes : TEST et PROD, l'une remplie, l'autre vide avec un bouton
 * « Appairer la production ». Ce bouton était une impasse — un Panel ne sert
 * qu'un environnement, et l'appairage de l'autre est refusé côté pont. La
 * ligne vide, elle, se lisait comme un constat sur la production du client,
 * alors que le Panel n'en savait rien.
 *
 * ══ CE QU'IL MONTRE ═════════════════════════════════════════════════════════
 *
 * L'instance de CETTE fiche : son état, l'environnement qu'elle DÉCLARE, sa
 * destination courante, ses deux horodatages distincts. Avant appairage, trois
 * de ces quatre valeurs sont « non connues » — et le disent.
 */
function ConnectionSection({ project }: { project: PublicProject }) {
  const { reload } = useProjects();
  const row = useMemo(() => toPairingRow(project), [project]);

  return (
    <Card title="Connexion">
      <p className="muted read-only-note">
        Cette fiche décrit UNE instance appairée : un projet distant, un
        environnement, une destination. L’environnement et la destination
        viennent du projet lui-même — le Panel ne les devine jamais.
      </p>

      <dl className="detail-list">
        <div>
          <dt>État</dt>
          <dd>
            <span className="pairing-state">
              <ConnectionStatusDot row={row} />
              <span className={`conn-state-label conn-state-${row.state.tone}`}>
                {row.state.label}
              </span>
            </span>
          </dd>
        </div>
        <div>
          <dt>Environnement <span className="dt-source">déclaré par le projet</span></dt>
          <dd>{row.environment ?? <span className="conn-unknown">— non connu —</span>}</dd>
        </div>
        <div>
          <dt>Destination <span className="dt-source">annoncée par le projet</span></dt>
          <dd>
            {row.destination
              ? <code className="inline-code">{row.destination}</code>
              : <span className="conn-unknown">— non connue —</span>}
          </dd>
        </div>
        <div>
          <dt>Dernier contact <span className="dt-source">observé par le Panel</span></dt>
          <dd>{row.lastContactLabel ?? <span className="conn-unknown">— jamais —</span>}</dd>
        </div>
        <div>
          <dt>Données métier <span className="dt-source">reçues et appliquées</span></dt>
          <dd>
            {row.lastBusinessSyncAt
              ? formatDateTime(row.lastBusinessSyncAt)
              : <span className="conn-unknown">— jamais reçues —</span>}
          </dd>
        </div>
      </dl>

      {/*
        UNE SEULE ACTION D'APPAIRAGE, ET ELLE PORTE SUR CETTE FICHE.
        Aucun bouton n'ajoute une seconde destination, ni n'appaire « la
        production » : ce serait une autre fiche, dans un autre Panel.
      */}
      <div className="pairing-actions">
        <ConnectionActions row={row} onDone={reload} />
      </div>
    </Card>
  );
}

function DeveloperTab({
  project,
  fraicheur,
}: {
  project: PublicProject;
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
      <ConnectionSection project={project} />

      <ServedActionsCard />

      {/*
        LES ÉCRITURES EN ÉCHEC VIVENT AVEC LA SUPERVISION, PAS AILLEURS.
        Une page dédiée aurait supposé qu'on sache déjà qu'un incident existe
        pour aller le chercher — or c'est précisément ce qu'on ignore.
      */}
      <DeadLettersCard projectId={project.projectId} />

      {/*
        ── LES QUATRE HORODATAGES NE FUSIONNENT JAMAIS ───────────────────────
        Ils décrivent quatre faits différents, et les confondre a déjà coûté un
        écran entier. Chacun dit lequel il est, et de qui il tient son
        information — le Panel, ou le projet.
      */}
      {/*
        ── DEUX RUNTIMES DÉCLARENT CE PROJET ──────────────────────────────────
        Posé AVANT la santé de synchronisation, parce qu'il la relativise
        entièrement : tant que deux logiciels parlent, chaque voyant décrit
        l'un OU l'autre, en alternance, sans qu'on sache lequel.

        Le Panel n'en élit aucun — le jeton de pont est la seule identité, et
        deux détenteurs légitimes sont indiscernables. Il nomme ; un humain
        tranche. Même doctrine que l'enlisement d'un rejeu.
      */}
      {d.rivalRuntime ? (
        <div className="alert alert-warning">
          <p>
            <strong>Deux runtimes déclarent ce projet.</strong> Les informations
            ci-dessous décrivent tantôt l’un, tantôt l’autre.
          </p>
          <ul className="alert-list">
            {d.rivalRuntime.identities.map((i, n) => (
              <li key={`${i.softwareVersion ?? 'inconnu'}-${n}`}>
                version logicielle <code className="inline-code">{i.softwareVersion ?? 'inconnue'}</code>
                {' '}— vue le {formatDateTime(i.at)}
              </li>
            ))}
          </ul>
          <p className="muted">
            {d.rivalRuntime.alternations} bascule(s) observée(s) depuis le{' '}
            {formatDateTime(d.rivalRuntime.detectedAt)}. Cause habituelle : une
            instance de développement lancée en local avec le jeton de pont de ce
            projet. Le Panel ne peut pas la refuser — c’est ce même jeton qui
            permet de redéployer sans réappairer. Arrêtez celle qui n’a pas lieu
            d’être ; le constat se referme seul ensuite.
          </p>
        </div>
      ) : null}

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
            {/*
              L'AUTORITÉ MÉTIER EST LE `projectId`, ET ELLE EST ÉCRITE EN PREMIER.

              L'identité logique figure plus bas, présentée pour ce qu'elle est :
              une PARENTÉ. Elle relie deux fiches du même produit ; elle ne
              détermine ni le nom, ni le contrat, ni la destination, ni la
              fraîcheur. Aucune donnée de cette page n'en dépend.
            */}
            <div><dt>Instance <span className="dt-source">autorité des données métier</span></dt>
              <dd><code className="inline-code">{project.projectId}</code></dd></div>
            <div><dt>Environnement</dt><dd>
              {project.environment ?? <span className="conn-unknown">— non connu —</span>}
            </dd></div>
            <div><dt>Destination</dt><dd>
              {project.descriptor?.primaryDomain
                ? <code className="inline-code">{project.descriptor.primaryDomain}</code>
                : <span className="conn-unknown">— non connue —</span>}
            </dd></div>
            <div><dt>Source de la présentation</dt><dd>
              <code className="inline-code">{project.descriptor?.presentationSource ?? '—'}</code>
            </dd></div>
            {/*
              L'IDENTITÉ LOGIQUE A QUITTÉ CET ÉCRAN.
              Elle ne détermine ni le nom, ni le contrat, ni la destination, ni
              la fraîcheur — et depuis que rien ne regroupe deux fiches, elle
              ne détermine plus rien du tout. Le champ reste en base pour les
              fiches historiques ; l'API ne le publie plus.
            */}
            <div><dt>Clé technique de la fiche <span className="dt-source">anti-collision, jamais un périmètre</span></dt>
              <dd><code className="inline-code">{project.projectKey}</code></dd></div>
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
              <dt>Dernière synchronisation métier <span className="dt-source">reçue et appliquée par le Panel</span></dt>
              <dd>
                {fraicheur.lastBusinessSyncAt
                  ? formatDateTime(fraicheur.lastBusinessSyncAt)
                  : <span className="muted">jamais reçue</span>}
              </dd>
            </div>
            <div>
              <dt>Dernière modification métier <span className="dt-source">annoncée par le projet</span></dt>
              <dd>
                {project.descriptor?.presentationModifiedAt
                  ? formatDateTime(project.descriptor.presentationModifiedAt)
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Âge de la photographie affichée <span className="dt-source">calculé à la lecture</span></dt>
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

        <DestinationsCard projectId={project.projectId} environment={project.environment ?? null} />

      <Card title="Fiche technique du projet">
        <dl className="detail-list">
          <div><dt>Identifiant technique</dt><dd><code className="inline-code">{project.projectKey}</code></dd></div>
          <div><dt>URL du site</dt><dd>{tech.site ?? '—'}</dd></div>
          <div><dt>URL du Manager</dt><dd>{tech.manager ?? '—'}</dd></div>
          {/*
            TOUJOURS AUCUN REPLI sur `runtime.publicBackendUrl` ICI, et c'est
            délibéré : cette ligne présente la DESTINATION, et mélanger deux
            sources dans une même case ferait ressembler une adresse de secours
            à une adresse constatée.

            L'adresse déclarée par le projet est affichée SÉPARÉMENT ci-dessous,
            avec son canal et sa date — un diagnostic, pas un repli. C'est ce
            qui permet de voir en un coup d'œil qu'une fiche est restée sur une
            adresse figée à l'appairage, ce que rien ne montrait auparavant.
          */}
          <div><dt>URL du backend</dt><dd>{tech.backend ?? '—'}</dd></div>
          <div>
            <dt>Adresse déclarée par le projet</dt>
            <dd>
              {project.runtime.publicBackendUrl ?? '—'}
              {project.runtime.publicBackendUrl
                && tech.backend
                && project.runtime.publicBackendUrl !== tech.backend ? (
                  <span className="badge badge-warn" style={{ marginLeft: '.5rem' }}>
                    diverge de la destination
                  </span>
                ) : null}
            </dd>
          </div>
          <div>
            <dt>Déclarée par / le</dt>
            <dd>
              {project.runtime.publicBackendUrlSource ?? '—'}
              {project.runtime.publicBackendUrlUpdatedAt
                ? ` · ${formatDateTime(project.runtime.publicBackendUrlUpdatedAt)}`
                : ''}
            </dd>
          </div>
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

/**
 * LES CAPACITÉS ACCORDÉES À CE PROJET (L3).
 *
 * ── CE QUE CETTE CARTE ACCORDE, ET CE QU'ELLE N'ACCORDE PAS ─────────────────
 *
 * Elle donne le droit de DEMANDER une action — « envoie cette notification »,
 * « vérifie que je peux écrire ». Elle ne donne aucune clé : le projet ne
 * détient rien, il demande, et le Panel exécute avec ses propres identifiants.
 * C'est toute la différence avec l'ancien écran d'autorisations, qui distribuait
 * des accès à des credentials.
 *
 * ── POURQUOI TOUT LE CATALOGUE, ET PAS SEULEMENT LES OCTROIS ────────────────
 *
 * Un écran qui n'affiche que ce qui est accordé ne permet pas d'accorder le
 * reste : il faudrait connaître les codes par cœur. On rend donc le catalogue
 * entier, chaque ligne disant si elle est accordée, et si elle servirait
 * vraiment.
 */
/**
 * LES ACTIONS SERVIES PAR CETTE INSTANCE — informatif, et rien d'autre.
 *
 * ── CE QUE CETTE CARTE ÉTAIT ────────────────────────────────────────────────
 *
 * « Capacités accordées » : une liste à cocher, projet par projet, doublée d'un
 * avertissement pour les capacités qu'on pouvait accorder sans qu'elles soient
 * servies (« Accordée, mais pas encore servie par le Panel… »). Cocher une case
 * était devenu un prérequis silencieux : un projet correctement appairé et
 * configuré refusait quand même, et rien à l'écran du projet ne disait laquelle
 * des vingt-deux cases manquait.
 *
 * ── POURQUOI LA GARDER MALGRÉ TOUT ──────────────────────────────────────────
 *
 * Parce que la question « qu'est-ce que cette instance sait faire ? » est
 * légitime, et qu'elle n'a pas de réponse ailleurs. Ce qui disparaît, c'est la
 * possibilité d'AGIR depuis cet écran — plus de case, plus d'état par projet,
 * donc plus rien à oublier de cocher.
 *
 * Elle ne prend d'ailleurs plus `projectId` : le catalogue est celui de
 * l'instance, identique pour tous les projets qu'elle sert. Lui passer un
 * projet laisserait croire qu'il pourrait différer de l'un à l'autre.
 */
function ServedActionsCard() {
  const [capabilities, setCapabilities] = useState<CapabilityView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { capabilities: liste } = await integratedApis.capabilities();
        setCapabilities(liste);
        setError(null);
      } catch (err) {
        setError(errorMessage(err, 'Catalogue indisponible.'));
      }
    })();
  }, []);

  if (!capabilities) {
    return (
      <Card title="IntegratedAPI centralisées">
        {error ? <div className="alert alert-error">{error}</div> : <p className="muted">Chargement…</p>}
      </Card>
    );
  }

  /**
   * Groupées par DOMAINE — le préfixe du code, pas le fournisseur.
   *
   * Un opérateur cherche « les actions de facturation », pas « les actions
   * Stripe » : le fournisseur est un détail d'implémentation que le Panel s'est
   * précisément donné pour mission de cacher au projet.
   */
  const domaines = new Map<string, CapabilityView[]>();
  for (const capability of capabilities) {
    const domaine = capability.code.split('.')[0] ?? 'autre';
    domaines.set(domaine, [...(domaines.get(domaine) ?? []), capability]);
  }

  const LIBELLES: Record<string, string> = {
    email: 'Email',
    billing: 'Facturation',
    signature: 'Signature',
    webhook: 'Webhooks',
    dns: 'DNS',
  };

  return (
    <Card title="IntegratedAPI centralisées">
      <p className="muted">
        Ce projet utilise les intégrations centralisées du Panel. Les
        identifiants externes restent stockés dans le Panel et ne sont{' '}
        <strong>jamais</strong> transmis au projet : le projet demande une
        action, le Panel l’exécute avec ses propres identifiants et ne renvoie
        que le résultat.
      </p>
      {error ? <div className="alert alert-error">{error}</div> : null}
      <p className="muted small">
        <strong>{capabilities.length} actions disponibles</strong> sur cette
        instance. Toutes sont servies : aucune n’est à activer projet par projet.
      </p>
      {[...domaines.entries()].map(([domaine, liste]) => (
        <div key={domaine}>
          <h4>{LIBELLES[domaine] ?? domaine}</h4>
          <ul className="plain-list">
            {liste.map((capability) => (
              <li key={capability.code}>
                <code>{capability.code}</code> — {capability.label}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

/**
 * LES COMPTES DU PROJET — lus EN DIRECT chez le projet, en lecture seule.
 *
 * ══ CE QUE CETTE CARTE MONTRAIT AVANT ═══════════════════════════════════════
 *
 * `project.business.team`, c'est-à-dire la projection `PanelProjectMember` du
 * Panel, alimentée par le flux de synchronisation. Trois défauts d'une même
 * cause — une deuxième source de vérité :
 *
 *   · elle VIEILLISSAIT entre deux synchronisations, sans qu'on puisse dire à
 *     l'écran si ce qu'on lisait était à jour ;
 *   · elle ne montrait QUE les comptes locaux. Les accès L.Y Solution — les
 *     identités fédérées qui entrent réellement ici — n'y figuraient pas ;
 *   · elle avait SA PROPRE FORME, différente de celle du Manager, pour décrire
 *     les mêmes personnes.
 *
 * Elle interroge désormais le projet, qui est l'autorité, et affiche ce qu'il
 * publie — la représentation canonique que son Manager utilise aussi.
 *
 * ══ ET QUAND LE PROJET NE RÉPOND PAS ════════════════════════════════════════
 *
 * On le DIT, et on ne montre RIEN d'autre. Ressortir un ancien instantané en
 * le faisant passer pour l'état courant est précisément ce que ce lot
 * supprime : une liste périmée sans étiquette est pire qu'une absence de
 * liste, parce qu'on la croit.
 */
function ProjectAccountsCard({ projectId }: { projectId: string }) {
  const [lecture, setLecture] = useState<ProjectAccountsRead | null>(null);
  const [chargement, setChargement] = useState(true);

  const lire = useCallback(async () => {
    setChargement(true);
    try {
      setLecture(await api.getProjectAccounts(projectId));
    } catch {
      /**
       * Le SERVICE du Panel ne lève pas : une indisponibilité du projet est un
       * résultat, pas une exception. Arriver ici signifie que le PANEL n'a pas
       * répondu — et on le dit avec le même vocabulaire, sans inventer un
       * troisième état.
       */
      setLecture({
        available: false,
        accounts: [],
        summary: null,
        readAt: null,
        reason: 'PANEL_UNREACHABLE',
        message: 'Comptes du projet temporairement indisponibles.',
      });
    } finally {
      setChargement(false);
    }
  }, [projectId]);

  useEffect(() => { void lire(); }, [lire]);

  const initiales = (compte: ProjectAccountView) => {
    const base = (compte.displayName || compte.email).trim();
    const mots = base.split(/[\s@.]+/).filter(Boolean);
    return (mots[0]?.[0] ?? '?').toUpperCase() + (mots[1]?.[0] ?? '').toUpperCase();
  };

  return (
    <Card title="Comptes du projet">
      {chargement && !lecture ? <p className="muted">Lecture en cours…</p> : null}

      {lecture && !lecture.available ? (
        <div className="alert alert-error">
          <p><strong>{lecture.message}</strong></p>
          <p className="muted">
            Cette liste est lue en direct dans le projet : elle n’est pas conservée ici,
            et rien de périmé n’est affiché à la place.
          </p>
          <p>
            <button type="button" className="btn btn-small" onClick={() => void lire()}>
              Réessayer
            </button>
          </p>
        </div>
      ) : null}

      {lecture?.available ? (
        <>
          {lecture.accounts.length === 0 ? (
            <p className="muted">Ce projet n’a aucun compte.</p>
          ) : (
            <ul className="team-list">
              {lecture.accounts.map((compte) => (
                <li key={compte.id} className="team-row">
                  <span className="project-avatar project-avatar-small">{initiales(compte)}</span>
                  <span className="team-row-main">
                    <span className="team-row-name">{compte.displayName}</span>
                    <span className="muted">{compte.email}</span>
                  </span>
                  {/*
                    LES MÊMES LIBELLÉS MÉTIER QUE DANS LE MANAGER.
                    « Accès L.Y Solution » désigne la même chose des deux côtés :
                    une identité du Panel projetée ici, jamais un compte local.
                  */}
                  <span className={compte.source === 'PANEL' ? 'badge badge-ok' : 'badge badge-muted'}>
                    {compte.source === 'PANEL' ? 'Accès L.Y Solution' : 'Compte du projet'}
                  </span>
                  <span className="badge badge-muted">{compte.role}</span>
                  {/*
                    « JAMAIS ACTIVÉ » ET « DÉSACTIVÉ » NE SE RÉPARENT PAS PAREIL.
                    Le premier appelle un lien d'activation à renvoyer, le second
                    un interrupteur à rouvrir. Les afficher sous le même mot
                    faisait chercher au mauvais endroit.
                  */}
                  {compte.status === 'PENDING_ACTIVATION' ? (
                    <span className="badge badge-warn">En attente d’activation</span>
                  ) : compte.enabled ? null : (
                    <span className="badge badge-warn">Désactivé</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="muted">
            {lecture.summary
              ? `${lecture.summary.local} compte(s) du projet, ${lecture.summary.panel} accès L.Y Solution.`
              : null}
            {lecture.readAt
              ? ` Lu dans le projet le ${new Date(lecture.readAt).toLocaleString('fr-FR')}.`
              : null}
          </p>
          <p className="muted">
            Les comptes du projet se gèrent dans son Manager ; les accès L.Y Solution
            depuis « Comptes L.Y Solution ». Cette vue est une supervision, pas une
            administration.
          </p>
        </>
      ) : null}
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
 * OÙ VIT CETTE INSTANCE — la vérité du Panel, pour SON environnement.
 *
 * ══ CE QUI A CHANGÉ ═════════════════════════════════════════════════════════
 *
 * Ce cadre affichait deux sections, `TEST` puis `PROD`, pour une fiche qui n'en
 * sert qu'une. La seconde disait invariablement « Aucune destination active »,
 * ce qui se lisait comme un défaut alors que c'était une absence de sujet.
 *
 * Une fiche non appairée n'affiche aucune destination : son environnement
 * n'est pas encore connu, donc la question « où vit-elle » n'a pas de réponse.
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
function DestinationsCard({
  projectId,
  environment,
}: {
  projectId: string;
  /** L'environnement DÉCLARÉ par le projet. `null` tant qu'il n'a pas parlé. */
  environment: 'TEST' | 'PROD' | null;
}) {
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

  // Tant que le projet n'a pas déclaré son environnement, la question « où
  // vit-il » n'a pas de réponse — et on ne la fabrique pas.
  if (!environment) {
    return (
      <Card title="Destination">
        <p className="muted">
          <span className="conn-unknown">— non connue —</span> Le projet n’a pas
          encore déclaré son environnement ni sa destination. Le Panel les
          enregistrera dès le premier échange.
        </p>
      </Card>
    );
  }

  if (!parEnv) {
    return (
      <Card title="Destination">
        <p className="muted">{erreur ?? 'Chargement…'}</p>
      </Card>
    );
  }

  const bloc = parEnv[environment];

  return (
    <Card title="Destination">
      <p className="muted read-only-note">
        Le Panel n’effectue aucun déploiement : cette destination est ce que le
        projet lui a ANNONCÉ depuis son propre poste. Un changement de domaine
        se déclenche là-bas, et la bascule n’a lieu ici qu’une fois la
        photographie complète reçue.
      </p>

      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      <section className="destination-env">
        {bloc?.active ? (
          <DestinationRow d={bloc.active} occupe={occupe} isDev={isDev} onAgir={agir} />
        ) : (
          <p className="muted">
            Aucune destination active. Le Panel ne sait pas où vit cette
            instance — et n’affichera aucune adresse plutôt qu’une adresse
            périmée.
          </p>
        )}

        {bloc?.pending ? (
          <div className="alert alert-warning">
            <strong>Migration annoncée vers {bloc.pending.host}.</strong> La
            bascule attend la photographie complète
            {bloc.pending.missing.length
              ? ` — il manque : ${bloc.pending.missing.join(', ')}.`
              : '.'}
          </div>
        ) : null}

        {bloc && bloc.history.length > 0 ? (
          <Disclosure title={`Historique (${bloc.history.length})`}>
            {bloc.history.map((d) => (
              <DestinationRow key={d.destinationId} d={d} occupe={occupe} isDev={isDev} onAgir={agir} />
            ))}
          </Disclosure>
        ) : null}
      </section>
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