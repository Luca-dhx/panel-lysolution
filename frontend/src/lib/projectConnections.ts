/**
 * LES CONNEXIONS D'UN PROJET — une fiche par instance, une carte par projet.
 *
 * ══ CE QUE CE MODULE TRADUIT ════════════════════════════════════════════════
 *
 * Le registre du Panel raisonne en INSTANCES : une fiche = un appairage = un
 * jeton = un environnement. C'est juste, et rien ici ne le remet en cause.
 *
 * L'opérateur, lui, raisonne en PROJETS CLIENTS. Il ne veut pas lire une liste
 * d'appairages techniques indépendants où « SB Auto » apparaît deux fois sans
 * que rien ne dise que c'est le même garage ; il veut voir un projet, et sous
 * lui ses deux connexions.
 *
 *   PROJET
 *   ├── TEST  → une fiche du registre, ou rien
 *   └── PROD  → une fiche du registre, ou rien
 *
 * ══ LE REGROUPEMENT NE DEVINE RIEN ══════════════════════════════════════════
 *
 * Il lit `logicalProjectKey` — la clé que le PROJET annonce lui-même au pont,
 * identique pour toutes ses instances. Aucune ressemblance de nom, aucun
 * préfixe de domaine, aucune heuristique : deux fiches se regroupent parce
 * qu'elles portent la même valeur déclarée, jamais parce qu'elles se
 * ressemblent.
 *
 * Une fiche SANS identité logique reste seule de son groupe. C'est le cas des
 * fiches antérieures à ce champ, et leur affichage est exactement celui
 * d'avant.
 *
 * ══ AUCUNE RÈGLE MÉTIER REDÉCIDÉE ICI ═══════════════════════════════════════
 *
 * Vivacité, fraîcheur, générations, états d'appairage : tout vient du backend.
 * Ce module range, il ne juge pas. Les seules décisions qu'il prend sont
 * d'affichage — quel libellé, quelle action proposer.
 */
import type { PublicProject } from '@/types';
import { getProjectDataFreshness, type ProjectDataFreshness } from '@/lib/projectFreshness';
import { lastContact, projectDisplayName, projectSiteUrl } from '@/lib/projectPresentation';

export const ENVIRONMENTS = ['TEST', 'PROD'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export type Tone = 'ok' | 'warn' | 'error' | 'neutral';

/**
 * L'ÉTAT D'UNE CONNEXION — un seul mot, lisible en moins de deux secondes.
 *
 * L'ordre des cas n'est pas décoratif : il va du plus déterminant au moins.
 * Un projet révoqué n'est pas « hors ligne », il est déconnecté ; un projet
 * jamais joint n'est pas « en panne », il attend.
 */
export type ConnectionStatus =
  | 'ABSENT'      // aucune fiche : cet environnement n'existe pas encore
  | 'DECLARED'    // fiche créée, jamais connectée
  | 'REVOKED'     // appairage retiré
  | 'ONLINE'      // relié et vivant
  | 'STALE'       // relié, signal en retard
  | 'OFFLINE';    // relié, plus aucun signe de vie

export interface ConnectionState {
  status: ConnectionStatus;
  label: string;
  tone: Tone;
  /** Le statut ne se lit JAMAIS à la seule couleur — voir §accessibilité. */
  symbol: '●' | '◐' | '○';
}

export interface EnvironmentConnection {
  environment: Environment;
  /** La fiche du registre qui sert cet environnement, ou `null`. */
  project: PublicProject | null;
  state: ConnectionState;
  /** Adresse publique servie, telle que le backend la résout. */
  host: string | null;
  /** « à l'instant », « il y a 3 heures »… ou `null` si jamais contacté. */
  lastContactLabel: string | null;
  /** La photographie métier réellement reçue par le Panel. */
  lastSnapshotAt: string | null;
  /** Les verdicts du backend, transportés tels quels. */
  freshness: ProjectDataFreshness | null;
  /** Y a-t-il quelque chose à faire dans cet environnement ? */
  needsAttention: boolean;
}

export interface ProjectGroup {
  /** Identité logique, ou l'identifiant de la fiche pour un groupe d'une seule. */
  key: string;
  /** `true` quand le groupe repose sur une identité logique déclarée. */
  grouped: boolean;
  name: string;
  tagline: string | null;
  connections: EnvironmentConnection[];
  /** Les fiches réellement présentes, pour les actions et la navigation. */
  projects: PublicProject[];
  /** Au moins un environnement demande une action. */
  needsAttention: boolean;
  /** Au moins une connexion est vivante. */
  hasOnline: boolean;
  /** Au moins un environnement reste à configurer. */
  hasMissing: boolean;
}

/* -------------------------------------------------------------------------- */
/*  ÉTAT D'UNE CONNEXION                                                      */
/* -------------------------------------------------------------------------- */

const ABSENTE: ConnectionState = {
  status: 'ABSENT', label: 'Non appairé', tone: 'neutral', symbol: '○',
};

export function connectionStateOf(project: PublicProject | null): ConnectionState {
  if (!project) return ABSENTE;

  // L'ÉTAT D'APPAIRAGE PRIME : un projet révoqué ou jamais relié ne peut pas
  // être « hors ligne » — il n'a jamais eu de ligne.
  if (project.pairing.status === 'REVOKED') {
    return { status: 'REVOKED', label: 'Déconnecté', tone: 'error', symbol: '○' };
  }
  if (project.pairing.status !== 'PAIRED') {
    return { status: 'DECLARED', label: 'En attente de connexion', tone: 'warn', symbol: '◐' };
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
 * CET ENVIRONNEMENT DEMANDE-T-IL UNE ACTION ?
 *
 * « Non appairé » n'en est PAS une : un projet qui n'a pas encore de production
 * est un projet normal, pas un projet en défaut. Le présenter comme une erreur
 * ferait clignoter la moitié du parc sans raison.
 */
export function connectionNeedsAttention(
  state: ConnectionState,
  freshness: ProjectDataFreshness | null,
): boolean {
  if (state.status === 'ABSENT') return false;
  if (state.status === 'ONLINE') return freshness ? !freshness.isBusinessDataFresh : false;
  return true;
}

/* -------------------------------------------------------------------------- */
/*  REGROUPEMENT                                                              */
/* -------------------------------------------------------------------------- */

/**
 * L'environnement d'une fiche, tel que le backend le publie.
 *
 * Le backend rend déjà le constat (`environment`, tiré du battement, à défaut
 * de l'intention déclarée). On ne le recalcule pas ici — et surtout on ne le
 * devine pas depuis un nom ou un domaine.
 */
export function environmentOf(project: PublicProject): Environment | null {
  const brut = project.environment ?? project.runtime?.environment ?? null;
  return brut === 'TEST' || brut === 'PROD' ? brut : null;
}

/** La clé de regroupement : l'identité logique, sinon la fiche elle-même. */
export function groupKeyOf(project: PublicProject): { key: string; grouped: boolean } {
  const logique = String(project.logicalProjectKey ?? '').trim();
  return logique
    ? { key: `logical:${logique}`, grouped: true }
    : { key: `project:${project.projectId}`, grouped: false };
}

function connectionOf(
  environment: Environment,
  project: PublicProject | null,
): EnvironmentConnection {
  const state = connectionStateOf(project);
  const freshness = project ? getProjectDataFreshness(project) : null;
  return {
    environment,
    project,
    state,
    host: project ? projectSiteUrl(project) : null,
    lastContactLabel: project ? lastContact(project) : null,
    lastSnapshotAt: freshness?.lastFullSyncAt ?? null,
    freshness,
    needsAttention: connectionNeedsAttention(state, freshness),
  };
}

/**
 * REGROUPE LES FICHES EN PROJETS.
 *
 * ── DEUX FICHES D'UN MÊME ENVIRONNEMENT ───────────────────────────────────
 * Le backend l'interdit à la déclaration. Si cela arrivait malgré tout —
 * données antérieures, écriture directe — on garde la PREMIÈRE et on n'écrase
 * rien : les surnuméraires deviennent leur propre groupe plutôt que de
 * disparaître de l'écran. Une donnée qu'on ne comprend pas se montre, elle ne
 * s'efface pas.
 *
 * ── ORDRE ─────────────────────────────────────────────────────────────────
 * Alphabétique sur le nom affiché. Un ordre stable évite qu'une carte saute
 * d'une place à l'autre au gré des battements.
 */
export function groupProjectsByLogicalProject(projects: PublicProject[]): ProjectGroup[] {
  const groupes = new Map<string, { grouped: boolean; fiches: PublicProject[] }>();
  const isoles: PublicProject[] = [];

  for (const project of projects) {
    const { key, grouped } = groupKeyOf(project);
    const env = environmentOf(project);
    const groupe = groupes.get(key);

    if (!groupe) {
      groupes.set(key, { grouped, fiches: [project] });
      continue;
    }

    // Deux fiches pour le même environnement : la seconde ne remplace pas la
    // première, elle vit à côté. Aucune n'est perdue.
    const dejaPris = env !== null && groupe.fiches.some((f) => environmentOf(f) === env);
    if (dejaPris) isoles.push(project);
    else groupe.fiches.push(project);
  }

  const construire = (key: string, grouped: boolean, fiches: PublicProject[]): ProjectGroup => {
    const parEnv = new Map<Environment, PublicProject>();
    for (const f of fiches) {
      const env = environmentOf(f);
      if (env && !parEnv.has(env)) parEnv.set(env, f);
    }

    /**
     * Une fiche SANS environnement connu — déclarée, jamais jointe — ne peut
     * être rangée ni en TEST ni en PROD. La ranger d'office quelque part
     * inventerait une information : on la rattache à l'environnement DÉCLARÉ
     * s'il existe, sinon elle reste hors des deux colonnes et le groupe la
     * garde dans `projects`.
     */
    const connections = ENVIRONMENTS.map((env) => connectionOf(env, parEnv.get(env) ?? null));

    // Le nom vient de la fiche la plus « parlante » : celle qui a poussé sa
    // présentation métier. À défaut, la première.
    const porteuse = fiches.find((f) => f.business?.presentation) ?? fiches[0];

    return {
      key,
      grouped: grouped && fiches.length > 1,
      name: projectDisplayName(porteuse),
      tagline: porteuse.business?.presentation?.tagline ?? porteuse.descriptor?.description ?? null,
      connections,
      projects: fiches,
      needsAttention: connections.some((c) => c.needsAttention),
      hasOnline: connections.some((c) => c.state.status === 'ONLINE'),
      hasMissing: connections.some((c) => c.state.status === 'ABSENT'),
    };
  };

  const resultat = [...groupes.entries()].map(([key, g]) => construire(key, g.grouped, g.fiches));
  for (const orphelin of isoles) {
    resultat.push(construire(`project:${orphelin.projectId}`, false, [orphelin]));
  }

  return resultat.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/* -------------------------------------------------------------------------- */
/*  RECHERCHE ET FILTRES                                                      */
/* -------------------------------------------------------------------------- */

export type ConnectionFilter = 'all' | 'test' | 'prod' | 'todo' | 'attention';

/** Une connexion RÉELLE dans cet environnement — pas une case vide. */
const aUneInstance = (group: ProjectGroup, env: Environment): boolean =>
  group.connections.some((c) => c.environment === env && c.state.status !== 'ABSENT');

/** Les compteurs des filtres — calculés une fois, affichés partout. */
export function filterCounts(groups: ProjectGroup[]): Record<ConnectionFilter, number> {
  return {
    all: groups.length,
    test: groups.filter((g) => aUneInstance(g, 'TEST')).length,
    prod: groups.filter((g) => aUneInstance(g, 'PROD')).length,
    todo: groups.filter((g) => g.hasMissing).length,
    attention: groups.filter((g) => g.needsAttention).length,
  };
}

export function matchesFilter(group: ProjectGroup, filter: ConnectionFilter): boolean {
  switch (filter) {
    case 'test': return aUneInstance(group, 'TEST');
    case 'prod': return aUneInstance(group, 'PROD');
    case 'todo': return group.hasMissing;
    case 'attention': return group.needsAttention;
    default: return true;
  }
}

/**
 * RECHERCHE — sur ce que l'utilisateur VOIT : le nom et les adresses.
 *
 * La clé technique y est aussi cherchée : un développeur qui colle une clé
 * depuis un log doit retrouver son projet, même si elle n'est affichée nulle
 * part sur la carte.
 */
export function matchesSearch(group: ProjectGroup, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const champs = [
    group.name,
    group.tagline ?? '',
    ...group.connections.map((c) => c.host ?? ''),
    ...group.projects.map((p) => p.projectKey),
    ...group.projects.map((p) => p.logicalProjectKey ?? ''),
  ];
  return champs.some((c) => c.toLowerCase().includes(q));
}

/* -------------------------------------------------------------------------- */
/*  LIENS PROFONDS                                                            */
/* -------------------------------------------------------------------------- */

/**
 * LE LIEN VERS UNE CONNEXION — une vraie URL, pas un état de navigation.
 *
 * ── POURQUOI PAS UN `state` DE ROUTEUR ────────────────────────────────────
 * Parce qu'un état de navigation ne survit pas à un rafraîchissement, ni à un
 * lien collé dans une conversation. L'onglet et l'environnement voulus vivent
 * donc dans l'URL, et la fiche les relit au montage.
 */
export function connectionLink(projectId: string, environment: Environment | null): string {
  const base = `/projects/${projectId}?tab=dev`;
  return environment ? `${base}&env=${environment}` : base;
}

/** Le lien de création d'une instance manquante, contexte déjà rempli. */
export function pairEnvironmentLink(
  environment: Environment,
  logicalProjectKey: string | null,
  projectName: string,
): string {
  const params = new URLSearchParams({ env: environment, name: projectName });
  if (logicalProjectKey) params.set('logical', logicalProjectKey);
  return `/projects?declare=1&${params.toString()}`;
}

export default groupProjectsByLogicalProject;
