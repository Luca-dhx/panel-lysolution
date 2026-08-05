/**
 * QUI DÉTIENT LES MÉDIAS — une seule instance, jamais deux.
 *
 * ── LE DÉFAUT D'ORIGINE ─────────────────────────────────────────────────────
 * Chaque instance du Panel écrivait dans son propre dossier. Un logo importé
 * depuis un poste de développement vivait sur ce poste ; le Panel déployé ne
 * l'avait jamais vu. Deux dossiers, deux vérités, et aucune façon de savoir
 * laquelle un projet afficherait.
 *
 * Synchroniser les deux aurait été pire : suppressions concurrentes, noms
 * identiques, empreintes divergentes, et une dépendance à un poste allumé.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────
 * Il y a UNE autorité média. Toute autre instance est un CLIENT : elle relaie,
 * elle ne stocke rien. Le navigateur ne parle jamais à l'autorité directement —
 * il parle à son backend, qui relaie en portant l'identité de l'appelant.
 *
 * ── COMMENT UNE INSTANCE SAIT CE QU'ELLE EST ────────────────────────────────
 * Elle compare l'adresse par laquelle ON L'ATTEINT à l'adresse CANONIQUE du
 * Panel. Deux pièges, tous deux réels :
 *
 *   · l'adresse canonique est celle de l'API (`api.panel.…`) alors qu'une
 *     instance se connaît par son adresse de façade (`panel.…`). Comparer les
 *     chaînes ferait croire au Panel déployé qu'il n'est pas l'autorité, et il
 *     se relaierait à lui-même — indéfiniment ;
 *
 *   · un poste de développement partage la BASE du Panel déployé. L'adresse
 *     canonique qu'il y lit est donc celle du déployé, pas la sienne.
 *
 * On compare donc les DOMAINES, préfixe d'API retiré. Et un poste dont la
 * propre adresse est une boucle locale n'est jamais l'autorité — sauf si
 * l'adresse canonique est elle aussi locale, c'est-à-dire qu'aucun Panel
 * déployé n'existe encore : le poste est alors seul, et se suffit.
 */
import { config } from '../../config/env.js';
import { resolveBackendUrl } from '../network/networkConfig.service.js';

/** Retire le préfixe d'API : `api.panel.x` et `panel.x` désignent le même Panel. */
function siteHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith('api.') ? h.slice(4) : h;
  } catch {
    return null;
  }
}

/** Une adresse qui ne désigne que la machine courante. */
function estLocale(url) {
  const h = siteHost(url);
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

/**
 * L'autorité média, et le rôle de CETTE instance.
 *
 * @returns {Promise<{authority: string|null, isAuthority: boolean, reason: string}>}
 *   `authority` : base absolue de l'autorité (jamais un chemin).
 *   `isAuthority` : cette instance stocke-t-elle elle-même ?
 */
export async function resolveMediaAuthority() {
  const { url: canonique } = await resolveBackendUrl();
  const moi = config.publicUrl || null;

  // Sans adresse canonique, il n'y a personne à qui relayer : cette instance
  // se suffit. C'est le cas d'un premier démarrage, avant toute publication.
  if (!canonique) {
    return { authority: null, isAuthority: true, reason: 'AUCUNE_ADRESSE_CANONIQUE' };
  }

  // Aucune adresse propre : on ne peut pas prouver qu'on est un client, et se
  // relayer à l'aveugle risquerait une boucle. On stocke.
  if (!moi) {
    return { authority: null, isAuthority: true, reason: 'ADRESSE_PROPRE_INCONNUE' };
  }

  // Le Panel canonique tourne en local : il n'y a pas encore de déployé.
  if (estLocale(canonique)) {
    return { authority: null, isAuthority: true, reason: 'CANONIQUE_LOCALE' };
  }

  // Même domaine, préfixe d'API retiré : c'est bien nous. Sans cette
  // comparaison, le Panel déployé se relaierait à lui-même.
  if (siteHost(moi) === siteHost(canonique)) {
    return { authority: canonique, isAuthority: true, reason: 'MEME_DOMAINE' };
  }

  return { authority: canonique, isAuthority: false, reason: 'INSTANCE_CLIENTE' };
}

/**
 * Relaie une requête vers l'autorité, en portant l'identité de l'appelant.
 *
 * ── AUCUN SECRET N'EST STOCKÉ ───────────────────────────────────────────────
 * On réémet le `Authorization` reçu. Les deux instances partagent la clé de
 * signature des jetons : celui de l'utilisateur est donc déjà valide côté
 * autorité. Rien à provisionner, rien à faire tourner, et surtout rien
 * d'administratif à placer dans un frontend.
 *
 * @param {string} authority  base absolue de l'autorité
 * @param {string} chemin     chemin à relayer, commençant par `/`
 * @param {object} options    { method, headers, body }
 */
export async function relayToAuthority(authority, chemin, { method = 'GET', headers = {}, body } = {}) {
  const cible = `${String(authority).replace(/\/+$/, '')}${chemin}`;
  const reponse = await fetch(cible, {
    method,
    headers,
    body,
    // Un média ne suit jamais de redirection : une redirection vers un autre
    // hôte ferait sortir la lecture de l'autorité sans qu'on le sache.
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  return reponse;
}

export default { resolveMediaAuthority, relayToAuthority };
