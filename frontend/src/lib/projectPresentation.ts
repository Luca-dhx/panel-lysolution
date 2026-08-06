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
 *   1. le nom commercial SYNCHRONISÉ, poussé par le projet à chaque
 *      modification — la seule source vivante ;
 *   2. `descriptor.name`, que le projet publie dans son manifeste ;
 *   3. le nom déclaré au Panel à la création ;
 *   4. l'identifiant technique — dernier recours, jamais un choix.
 *
 * Les rangs 2 à 4 sont des SECOURS, pas des sources métier : le manifeste est
 * une photographie prise à l'appairage ou sur action manuelle. Un projet qui
 * n'a jamais rien poussé s'affiche donc, mais `isBusinessSynchronized` le
 * signale — voir le commentaire de cette fonction.
 *
 * `descriptor.description` n'entre pas dans cette liste : c'est une phrase de
 * présentation (« Garage du Nord — vitrine et Manager »), pas un nom. L'utiliser
 * comme titre donnerait des libellés de trois lignes.
 */
/**
 * Le projet a-t-il déjà poussé son identité commerciale ?
 *
 * ── POURQUOI CETTE FONCTION EXISTE ─────────────────────────────────────────
 * Sans elle, une synchronisation en panne était INVISIBLE : les écrans
 * retombaient silencieusement sur le manifeste, une photographie prise à
 * l'appairage. L'utilisateur voyait un nom — l'ancien — et concluait que sa
 * modification n'avait pas été enregistrée, alors que le problème était le
 * lien entre les deux systèmes.
 *
 * Un secours muet qui ressemble à une donnée à jour est pire que pas de
 * secours du tout. Les écrans affichent donc le repli, mais le DISENT.
 */
export function isBusinessSynchronized(project: PublicProject): boolean {
  return Boolean(project.business?.presentation);
}

export function projectDisplayName(project: PublicProject): string {
  // La projection POUSSÉE prime : elle arrive à chaque modification, alors que
  // le manifeste n'est relu qu'à l'appairage ou sur action manuelle.
  const pushed = project.business?.presentation?.companyName?.trim();
  if (pushed) return pushed;
  const commercial = project.descriptor?.presentation?.companyName?.trim();
  if (commercial) return commercial;
  const fromManifest = project.descriptor?.name?.trim();
  if (fromManifest) return fromManifest;
  const declared = project.projectName?.trim();
  if (declared) return declared;
  return project.projectKey;
}

/**
 * Phrase de présentation. Le SLOGAN du client prime sur la description du
 * descripteur : cette dernière décrit le projet modèle et se retrouvait,
 * identique, sur chaque duplicata.
 */
export function projectDescription(project: PublicProject): string | null {
  const pushed = project.business?.presentation?.tagline?.trim();
  if (pushed) return pushed;
  const tagline = project.descriptor?.presentation?.tagline?.trim();
  if (tagline) return tagline;
  const d = project.descriptor?.description?.trim();
  return d && d.length > 0 ? d : null;
}

/**
 * Logo publié par le projet — URL absolue, résolue par LUI contre son propre
 * domaine (voir MEDIAS_PUBLICS.md). Le Panel ne stocke aucun média ; en
 * l'absence de logo, l'appelant affiche les initiales.
 */
export function projectLogoUrl(project: PublicProject): string | null {
  const pushed = project.business?.presentation?.logoUrl?.trim();
  if (pushed) return pushed;
  const logo = project.descriptor?.presentation?.logoUrl?.trim();
  return logo && logo.length > 0 ? logo : null;
}

/** Moyens de contact publiés, filtrés par le projet (activés seulement). */
export function projectContacts(project: PublicProject): {
  email?: string;
  phone?: string;
  website?: string;
} | null {
  const pushed = project.business?.presentation?.contacts;
  if (pushed && Object.values(pushed).some(Boolean)) {
    return {
      ...(pushed.email ? { email: pushed.email } : {}),
      ...(pushed.phone ? { phone: pushed.phone } : {}),
      ...(pushed.website ? { website: pushed.website } : {}),
    };
  }
  const c = project.descriptor?.presentation?.contacts;
  return c && Object.keys(c).length > 0 ? c : null;
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

/* -------------------------------------------------------------------------- */
/*  ADRESSES — UNE SEULE SOURCE, POUR TOUTES LES VUES                         */
/* -------------------------------------------------------------------------- */
//
// ══ LE DÉFAUT CORRIGÉ ══════════════════════════════════════════════════════
//
// Ces fonctions lisaient DEUX sources différentes, et pas les mêmes selon la
// fonction :
//
//   · `projectSiteUrl`       → la projection poussée, puis le manifeste ;
//   · `projectTechnicalUrls` → le manifeste seul ;
//   · `BridgesPage`          → `runtime.publicBackendUrl` ;
//
// Or ces trois champs sont écrits à trois moments différents. Un projet qui
// change de domaine sans se réappairer ne rafraîchit que la projection : la
// vitrine passait donc au nouveau domaine pendant que le backend, le domaine
// principal et la page Bridges restaient sur l'ancien. Deux vérités affichées
// côte à côte, sans que rien ne signale laquelle était juste.
//
// Constaté sur « Demo SB Auto » : site sur `demo-sbauto06.ly-solution.com`,
// backend et domaine principal sur `demo-sbauto.lycarz.com`.
//
// ══ LA RÈGLE ═══════════════════════════════════════════════════════════════
//
// Toutes lisent désormais `descriptor.urls`, que le backend remplit depuis la
// DESTINATION ACTIVE du projet dans son environnement courant — et depuis rien
// d'autre. Aucune concaténation, aucun repli sur un ancien manifeste. Quand
// l'adresse est inconnue, elles rendent `null` : « inconnu » est une réponse,
// une adresse périmée présentée comme actuelle n'en est pas une.

/**
 * Adresse publique du SITE, et rien d'autre.
 *
 * On lit `website`, jamais « la première venue » : cela ferait afficher l'URL
 * de l'API — `api.<domaine>` — comme adresse du client, et `manager` montrerait
 * l'administration à sa place.
 */
export function projectSiteUrl(project: PublicProject): string | null {
  const site = project.descriptor?.urls?.website?.trim();
  return site && site.length > 0 ? site : null;
}

/**
 * Adresses TECHNIQUES du projet — Manager et backend. Réservées à l'onglet
 * Développeur : ni l'une ni l'autre n'est l'adresse du client.
 */
export function projectTechnicalUrls(project: PublicProject): {
  manager: string | null;
  backend: string | null;
} {
  const urls = project.descriptor?.urls ?? null;
  return {
    manager: urls?.manager?.trim() || null,
    backend: urls?.backend?.trim() || null,
  };
}

/** Domaine principal, tel que la destination active le porte. */
export function projectDomain(project: PublicProject): string | null {
  return project.descriptor?.primaryDomain ?? null;
}

/**
 * Le Panel sait-il OÙ vit ce projet ?
 *
 * `false` quand aucune destination active n'est connue — un projet jamais
 * appairé, ou qui n'a encore rien annoncé. L'écran doit alors dire « inconnu »,
 * jamais afficher une adresse tirée d'ailleurs.
 */
export function hasResolvedNetwork(project: PublicProject): boolean {
  return project.descriptor?.networkSource === 'DESTINATION_ACTIVE';
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

/* -------------------------------------------------------------------------- */
/*  CONTRAT — tel que le projet le publie                                     */
/* -------------------------------------------------------------------------- */

/** Statut de contrat, en français. Les codes restent côté Développeur. */
export function contractState(status: string): ReadableState {
  switch (status) {
    case 'ACTIVE':
      return { label: 'Contrat actif', tone: 'ok' };
    case 'CANCEL_AT_PERIOD_END':
      return { label: 'Résilié — actif jusqu’à l’échéance', tone: 'warn' };
    case 'ENDED':
      return { label: 'Contrat terminé', tone: 'error' };
    case 'CANCELLED':
      return { label: 'Contrat annulé', tone: 'error' };
    case 'FAILED':
      return { label: 'Contrat en échec', tone: 'error' };
    case 'INACTIVE':
    case 'ACTIVATION_IN_PROGRESS':
      return { label: 'En cours d’activation', tone: 'warn' };
    case 'PENDING_DEV_SIGNATURE':
    case 'DRAFT':
      return { label: 'En préparation', tone: 'neutral' };
    default:
      return { label: status, tone: 'neutral' };
  }
}

/** Montants en CENTIMES côté projet — on les rend lisibles, jamais bruts. */
export function formatAmount(amount: { amountIncludingTax: number | null; currency: string | null } | null): string | null {
  if (!amount || amount.amountIncludingTax === null) return null;
  const value = amount.amountIncludingTax / 100;
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: amount.currency || 'EUR',
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${amount.currency ?? ''}`.trim();
  }
}

/** « par mois » / « par an » — jamais `interval: 'month'`. */
export function formatInterval(interval: string | null | undefined): string | null {
  if (!interval) return null;
  if (/month/i.test(interval)) return 'par mois';
  if (/year|annual/i.test(interval)) return 'par an';
  return interval;
}
