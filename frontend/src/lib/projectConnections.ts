/**
 * LES APPAIRAGES — une fiche du Panel, une ligne, et rien entre les deux.
 *
 * ══ LA DOCTRINE, TENUE EN UNE PHRASE ════════════════════════════════════════
 *
 *   1 fiche Panel = 1 appairage = 1 projet distant = 1 environnement
 *                 = 1 destination = 1 état métier.
 *
 * ══ CE QUE CE MODULE FAISAIT, ET POURQUOI C'EST PARTI ═══════════════════════
 *
 * Il regroupait les fiches par `logicalProjectKey` et présentait chaque projet
 * comme une carte à deux lignes, TEST et PROD, avec des cases vides à
 * « appairer ». Le modèle était séduisant et faux sur trois points :
 *
 *   · une instance de Panel ne sert QU'UN environnement — le bootstrap refuse
 *     tout projet dont l'environnement ne concorde pas. La ligne PROD d'un
 *     Panel de recette ne pouvait donc jamais se remplir : elle proposait une
 *     action structurellement impossible ;
 *   · une case vide n'est pas une donnée. « PROD ○ Non appairé » se lisait
 *     comme un constat sur la production du client, alors que le Panel n'en
 *     savait rien du tout ;
 *   · une fiche NON APPAIRÉE affichait un environnement et une destination
 *     tirés de la saisie locale. Le projet n'avait pas encore parlé : il n'y
 *     avait rien à afficher.
 *
 * ══ CE QU'IL FAIT MAINTENANT ════════════════════════════════════════════════
 *
 * Il traduit UNE fiche en UNE ligne. Aucun regroupement, aucun environnement
 * inventé, aucune destination supposée. Avant appairage : le nom, l'état
 * « Non appairé », et l'action d'appairer. Après : ce que le projet déclare.
 *
 * ══ AUCUNE RÈGLE MÉTIER REDÉCIDÉE ICI ═══════════════════════════════════════
 *
 * Vivacité, fraîcheur, générations, environnement, destination : tout vient du
 * backend. Ce module met en forme, il ne juge pas.
 */
import type { PublicProject } from '@/types';
import { getProjectDataFreshness, type ProjectDataFreshness } from '@/lib/projectFreshness';
import { lastContact, projectDisplayName, projectSiteUrl } from '@/lib/projectPresentation';

export type Environment = 'TEST' | 'PROD';

export type Tone = 'ok' | 'warn' | 'error' | 'neutral';

/**
 * L'ÉTAT D'UNE FICHE — un seul mot, lisible en moins de deux secondes.
 *
 * L'ordre des cas n'est pas décoratif : il va du plus déterminant au moins.
 * Un projet révoqué n'est pas « hors ligne », il est déconnecté ; un projet
 * jamais joint n'est pas « en panne », il attend.
 */
export type ConnectionStatus =
  | 'UNPAIRED'    // fiche créée, jamais appairée
  | 'REVOKED'     // appairage retiré
  | 'ONLINE'      // appairé et vivant
  | 'STALE'       // appairé, signal en retard
  | 'OFFLINE';    // appairé, plus aucun signe de vie

export interface ConnectionState {
  status: ConnectionStatus;
  label: string;
  tone: Tone;
  /** Le statut ne se lit JAMAIS à la seule couleur — voir §accessibilité. */
  symbol: '●' | '◐' | '○';
}

/**
 * UNE LIGNE DE LA PAGE APPAIRAGES — la projection d'UNE fiche, et d'une seule.
 *
 * Tous les champs propres au projet distant valent `null` tant qu'il n'a rien
 * déclaré. C'est volontaire et c'est vérifié par les tests : « inconnu » est
 * une réponse, une valeur devinée n'en est pas une.
 */
export interface PairingRow {
  projectId: string;
  /** Nom courant : la projection poussée si elle existe, sinon le nom de la fiche. */
  name: string;
  tagline: string | null;
  paired: boolean;
  state: ConnectionState;
  /** L'environnement DÉCLARÉ par le projet appairé. `null` avant appairage. */
  environment: Environment | null;
  /** La destination courante, telle que le projet l'annonce. `null` avant. */
  destination: string | null;
  /** « à l'instant », « il y a 3 heures »… ou `null` si jamais contacté. */
  lastContactLabel: string | null;
  /** La photographie métier réellement reçue et appliquée par le Panel. */
  lastBusinessSyncAt: string | null;
  /** Les verdicts du backend, transportés tels quels. */
  freshness: ProjectDataFreshness;
  /** Y a-t-il quelque chose à faire sur cette fiche ? */
  needsAttention: boolean;
  /** La fiche elle-même, pour les actions. */
  project: PublicProject;
}

/* -------------------------------------------------------------------------- */
/*  ÉTAT D'UNE FICHE                                                          */
/* -------------------------------------------------------------------------- */

export function connectionStateOf(project: PublicProject): ConnectionState {
  // L'ÉTAT D'APPAIRAGE PRIME : un projet révoqué ou jamais relié ne peut pas
  // être « hors ligne » — il n'a jamais eu de ligne.
  if (project.pairing.status === 'REVOKED') {
    return { status: 'REVOKED', label: 'Déconnecté', tone: 'error', symbol: '○' };
  }
  if (project.pairing.status !== 'PAIRED') {
    return { status: 'UNPAIRED', label: 'Non appairé', tone: 'neutral', symbol: '○' };
  }

  // La vivacité est calculée par le backend. On la traduit, on ne la refait pas.
  switch (project.liveness) {
    case 'ONLINE':
      return { status: 'ONLINE', label: 'Connecté', tone: 'ok', symbol: '●' };
    case 'STALE':
      return { status: 'STALE', label: 'Signal en retard', tone: 'warn', symbol: '◐' };
    default:
      return { status: 'OFFLINE', label: 'Hors ligne', tone: 'error', symbol: '○' };
  }
}

/**
 * CETTE FICHE DEMANDE-T-ELLE UNE ACTION ?
 *
 * « Non appairé » n'en est PAS une : une fiche qu'on vient de déclarer est une
 * fiche normale, pas une fiche en défaut. La présenter comme une erreur ferait
 * clignoter la moitié du parc sans raison — et l'action d'appairer est déjà
 * proposée sur la ligne.
 */
export function connectionNeedsAttention(
  state: ConnectionState,
  freshness: ProjectDataFreshness,
): boolean {
  if (state.status === 'UNPAIRED') return false;
  if (state.status === 'ONLINE') return !freshness.isBusinessDataFresh;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  UNE FICHE, UNE LIGNE                                                      */
/* -------------------------------------------------------------------------- */

/**
 * L'ENVIRONNEMENT D'UNE FICHE — celui que le backend publie, ou rien.
 *
 * Le backend ne le renseigne QUE pour une fiche appairée, à partir de ce que
 * le projet déclare. Aucune déduction ici : ni depuis le nom, ni depuis le
 * domaine, ni depuis une intention de saisie.
 */
export function environmentOf(project: PublicProject): Environment | null {
  if (project.pairing.status !== 'PAIRED') return null;
  const brut = project.environment ?? null;
  return brut === 'TEST' || brut === 'PROD' ? brut : null;
}

/**
 * LA DESTINATION D'UNE FICHE — l'adresse publique que le projet annonce.
 *
 * `null` avant appairage, et `null` tant qu'aucune destination active n'est
 * connue. Le backend a déjà tranché (`descriptor.primaryDomain`) ; on ne
 * recompose rien à partir d'une URL de secours.
 */
export function destinationOf(project: PublicProject): string | null {
  if (project.pairing.status !== 'PAIRED') return null;
  const host = project.descriptor?.primaryDomain?.trim();
  if (host) return host;
  const site = projectSiteUrl(project);
  return site ? site.replace(/^https?:\/\//, '') : null;
}

/** Traduit UNE fiche du registre en UNE ligne d'écran. */
export function toPairingRow(project: PublicProject): PairingRow {
  const state = connectionStateOf(project);
  const freshness = getProjectDataFreshness(project);
  const paired = project.pairing.status === 'PAIRED';
  return {
    projectId: project.projectId,
    name: projectDisplayName(project),
    tagline: paired ? (project.business?.presentation?.tagline ?? null) : null,
    paired,
    state,
    environment: environmentOf(project),
    destination: destinationOf(project),
    lastContactLabel: lastContact(project),
    lastBusinessSyncAt: freshness.lastBusinessSyncAt,
    freshness,
    needsAttention: connectionNeedsAttention(state, freshness),
    project,
  };
}

/**
 * LA LISTE DE LA PAGE — une ligne par fiche, dans un ordre stable.
 *
 * Ordre alphabétique sur le nom affiché : une ligne ne doit pas sauter d'une
 * place à l'autre au gré des battements de cœur.
 */
export function toPairingRows(projects: PublicProject[]): PairingRow[] {
  return projects
    .map(toPairingRow)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/* -------------------------------------------------------------------------- */
/*  RECHERCHE ET FILTRES                                                      */
/* -------------------------------------------------------------------------- */

/**
 * LES FILTRES PORTENT SUR L'ÉTAT DU LIEN — jamais sur l'environnement.
 *
 * `TEST` et `PROD` ont disparu de cette barre : une instance de Panel n'en
 * sert qu'un, et filtrer sur l'autre ne pouvait que rendre une liste vide.
 */
export type ConnectionFilter = 'all' | 'paired' | 'unpaired' | 'attention';

export function filterCounts(rows: PairingRow[]): Record<ConnectionFilter, number> {
  return {
    all: rows.length,
    paired: rows.filter((r) => r.paired).length,
    unpaired: rows.filter((r) => !r.paired).length,
    attention: rows.filter((r) => r.needsAttention).length,
  };
}

export function matchesFilter(row: PairingRow, filter: ConnectionFilter): boolean {
  switch (filter) {
    case 'paired': return row.paired;
    case 'unpaired': return !row.paired;
    case 'attention': return row.needsAttention;
    default: return true;
  }
}

/**
 * RECHERCHE — sur ce que l'utilisateur VOIT : le nom, le slogan, la destination.
 *
 * La clé technique y est aussi cherchée : un développeur qui colle une clé
 * depuis un journal doit retrouver sa fiche, même si elle n'est affichée nulle
 * part sur la ligne.
 */
export function matchesSearch(row: PairingRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const champs = [
    row.name,
    row.tagline ?? '',
    row.destination ?? '',
    row.project.projectKey,
  ];
  return champs.some((c) => c.toLowerCase().includes(q));
}

/* -------------------------------------------------------------------------- */
/*  LIENS                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * LE LIEN VERS LA FICHE — une vraie URL, pas un état de navigation.
 *
 * ── CE QUI A DISPARU ──────────────────────────────────────────────────────
 * `connectionLink(projectId, environment)` ajoutait `&env=TEST`. Il servait à
 * mettre en avant l'une des deux lignes d'une fiche qui en portait deux. Une
 * fiche n'en porte plus qu'une : il n'y a plus rien à désigner.
 *
 * `pairEnvironmentLink` a disparu pour la même raison : on n'appaire pas « la
 * production DE cette fiche ». Une autre instance, c'est une autre fiche, et
 * elle se déclare depuis la page Projets.
 */
export function manageLink(projectId: string): string {
  return `/projects/${projectId}?tab=dev`;
}

export default toPairingRows;
