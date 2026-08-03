/**
 * PRÉSENTATION MÉTIER D'UN PROJET — la traduction, au même endroit pour tous
 * les écrans de gestion.
 *
 * Le Panel s'adresse à toute l'équipe. Or ses écrans parlaient `liveness`,
 * `heartbeat`, `contractVersion` et `manifest` — un vocabulaire qui décrit
 * l'infrastructure, pas le client. Ce module ne masque rien : il dit la même
 * chose en français ordinaire, et laisse les pages Développeur garder les
 * termes techniques, qui y sont utiles au diagnostic.
 */
import type { PublicProject } from '@/types';

/* -------------------------------------------------------------------------- */
/*  NOM AFFICHABLE                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Nom lisible d'un projet, par ordre de préférence DÉCROISSANTE :
 *
 *   1. le nom commercial synchronisé — n'existe PAS encore : le pont ne
 *      transporte ni raison sociale ni logo. La place est réservée ici pour
 *      que le jour où il arrivera, un seul endroit change ;
 *   2. `descriptor.name`, que le projet publie dans son manifeste ;
 *   3. le nom déclaré au Panel à la création ;
 *   4. l'identifiant technique — dernier recours, jamais un choix.
 *
 * `descriptor.description` n'entre pas dans cette liste : c'est une phrase de
 * présentation (« Garage du Nord — vitrine et Manager »), pas un nom. L'utiliser
 * comme titre donnerait des libellés de trois lignes.
 */
export function projectDisplayName(project: PublicProject): string {
  const fromManifest = project.descriptor?.name?.trim();
  if (fromManifest) return fromManifest;
  const declared = project.projectName?.trim();
  if (declared) return declared;
  return project.projectKey;
}

/** Phrase de présentation publiée par le projet, ou `null`. */
export function projectDescription(project: PublicProject): string | null {
  const d = project.descriptor?.description?.trim();
  return d && d.length > 0 ? d : null;
}

/** Initiales pour l'avatar de repli — aucun logo n'est encore synchronisé. */
export function projectInitials(project: PublicProject): string {
  const words = projectDisplayName(project)
    .split(/[\s-]+/)
    .filter((w) => /[a-zA-Z0-9]/.test(w));
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Adresse publique du site, telle que le PROJET la publie. Le manifeste donne
 * un jeu d'URLs nommées ; on préfère celle du site, puis la première venue.
 *
 * Deux replis sont volontairement absents :
 *   · l'URL du BACKEND — ce n'est pas une adresse qu'on montre à un client ;
 *   · le domaine seul, préfixé d'un schéma choisi par nous — ce serait produire
 *     un lien qu'on n'a jamais vérifié. Le domaine est rendu comme TEXTE par
 *     `projectDomain`, sans prétendre être cliquable.
 */
export function projectSiteUrl(project: PublicProject): string | null {
  const urls = project.descriptor?.urls ?? null;
  if (!urls) return null;
  const preferred = urls.site ?? urls.website ?? urls.vitrine ?? null;
  if (preferred) return preferred;
  return Object.values(urls)[0] ?? null;
}

/** Domaine principal annoncé, pour l'afficher quand aucune URL complète n'existe. */
export function projectDomain(project: PublicProject): string | null {
  return project.descriptor?.primaryDomain ?? null;
}

/* -------------------------------------------------------------------------- */
/*  ÉTATS, EN FRANÇAIS                                                        */
/* -------------------------------------------------------------------------- */

export type Tone = 'ok' | 'warn' | 'error' | 'neutral';

export interface ReadableState {
  label: string;
  tone: Tone;
}

/**
 * ÉTAT DE CONNEXION (ex-`liveness`) — répond à « le site nous parle-t-il ? ».
 * Chaque libellé dit ce qui se passe, pas le nom du code interne.
 */
export function connectionState(project: PublicProject): ReadableState {
  switch (project.liveness) {
    case 'ONLINE':
      return { label: 'Connecté', tone: 'ok' };
    case 'STALE':
      return { label: 'Contact ancien', tone: 'warn' };
    case 'OFFLINE':
      return { label: 'Ne communique plus', tone: 'error' };
    case 'NEVER_SEEN':
      return { label: 'Jamais connecté', tone: 'warn' };
    case 'NOT_PAIRED':
    default:
      return { label: 'Non relié au Panel', tone: 'neutral' };
  }
}

/**
 * ÉTAT DU SITE (ex-`health`) — répond à « le site fonctionne-t-il ? ».
 * Tant qu'aucun contact n'a eu lieu, on dit qu'on ne sait pas : « inconnu »
 * et « en panne » ne doivent jamais se confondre.
 */
export function siteState(project: PublicProject): ReadableState {
  if (project.pairing.status !== 'PAIRED') {
    return { label: 'Non suivi', tone: 'neutral' };
  }
  const health = project.runtime.lastHealth;
  if (!health) return { label: 'Jamais vérifié', tone: 'neutral' };
  if (health.status === 'OK') {
    return project.liveness === 'ONLINE'
      ? { label: 'En ligne', tone: 'ok' }
      : { label: 'À vérifier', tone: 'warn' };
  }
  return { label: 'À vérifier', tone: 'warn' };
}

/** Le projet est-il relié au Panel ? (ex-`pairing.status`) */
export function linkState(project: PublicProject): ReadableState {
  switch (project.pairing.status) {
    case 'PAIRED':
      return { label: 'Relié au Panel', tone: 'ok' };
    case 'REVOKED':
      return { label: 'Déconnecté', tone: 'error' };
    case 'DECLARED':
    default:
      return { label: 'En attente de connexion', tone: 'warn' };
  }
}

/* -------------------------------------------------------------------------- */
/*  DURÉES ET DATES                                                           */
/* -------------------------------------------------------------------------- */

/** « il y a 12 minutes » plutôt que `secondsSinceLastHeartbeat: 743`. */
export function relativeSince(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null;
  if (seconds < 60) return 'à l’instant';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} minute${minutes > 1 ? 's' : ''}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} heure${hours > 1 ? 's' : ''}`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} jour${days > 1 ? 's' : ''}`;
}

/** Dernier contact, en clair. `null` si le projet n'a jamais parlé. */
export function lastContact(project: PublicProject): string | null {
  return relativeSince(project.secondsSinceLastHeartbeat);
}

/* -------------------------------------------------------------------------- */
/*  ALERTES — ce qu'un non-technicien doit comprendre et pouvoir transmettre  */
/* -------------------------------------------------------------------------- */

export interface ProjectAlert {
  projectId: string;
  projectName: string;
  message: string;
  tone: Tone;
}

/**
 * Traduit un état anormal en phrase actionnable. Le détail technique — code
 * d'erreur, version de contrat, composants — reste dans l'espace Développeur :
 * ici on dit ce qui se passe et à qui s'adresser, pas comment le réparer.
 */
export function projectAlert(project: PublicProject): ProjectAlert | null {
  const base = { projectId: project.projectId, projectName: projectDisplayName(project) };

  if (project.pairing.status === 'REVOKED') {
    return { ...base, message: 'Le projet a été déconnecté du Panel.', tone: 'error' };
  }
  if (project.pairing.status === 'DECLARED') {
    return { ...base, message: 'Le projet attend d’être relié au Panel.', tone: 'warn' };
  }
  if (project.liveness === 'OFFLINE') {
    const since = lastContact(project);
    return {
      ...base,
      message: since
        ? `Le site ne communique plus avec le Panel (dernier contact ${since}).`
        : 'Le site ne communique plus avec le Panel.',
      tone: 'error',
    };
  }
  if (project.liveness === 'NEVER_SEEN') {
    return { ...base, message: 'Le site n’a jamais communiqué avec le Panel.', tone: 'warn' };
  }
  if (project.liveness === 'STALE') {
    const since = lastContact(project);
    return {
      ...base,
      message: since
        ? `Le site n’a pas donné de nouvelles depuis ${since.replace('il y a ', '')}.`
        : 'Le site n’a pas donné de nouvelles récemment.',
      tone: 'warn',
    };
  }
  if (project.runtime.lastHealth && project.runtime.lastHealth.status !== 'OK') {
    return { ...base, message: 'Le site nécessite une vérification technique.', tone: 'warn' };
  }
  return null;
}

/** Classe de badge correspondant à un ton — réutilise les styles existants. */
export function toneBadgeClass(tone: Tone): string {
  if (tone === 'ok') return 'badge badge-ok';
  if (tone === 'warn') return 'badge badge-warn';
  if (tone === 'error') return 'badge badge-danger';
  return 'badge badge-muted';
}
