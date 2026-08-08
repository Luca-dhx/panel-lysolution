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
import { MediaAuthorityClient } from '../../bridge/MediaAuthorityClient.js';
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
 * L'ADRESSE DE L'AUTORITÉ POUR CET ENVIRONNEMENT.
 *
 * ── POURQUOI LA DESTINATION ACTIVE PASSE DEVANT ─────────────────────────────
 * L'autorité se lisait dans la configuration réseau. Deux défauts, tous deux
 * observés :
 *
 *   · elle ne distingue pas TEST de PROD. Un poste de recette pouvait donc
 *     relayer ses médias vers l'instance de production — un mélange
 *     d'environnements que rien n'aurait signalé ;
 *   · elle n'est pas remise à jour quand une destination est RETIRÉE. On
 *     relayait alors vers une adresse rendue, ou mise en quarantaine.
 *
 * La destination ACTIVE de l'environnement courant répond aux deux : elle est
 * unique par environnement, et cesse d'exister dès qu'elle est retirée. La
 * configuration réseau reste le repli — un Panel dont aucune destination n'est
 * encore enregistrée continue de fonctionner comme avant.
 */
async function adresseCanonique() {
  const { activePanelDestination } = await import('./mediaDescriptor.service.js');
  const destination = await activePanelDestination(config.env).catch(() => null);
  if (destination?.url) return String(destination.url).trim().replace(/\/+$/, '');
  const { url } = await resolveBackendUrl();
  return url || null;
}

/**
 * L'autorité média, et le rôle de CETTE instance.
 *
 * @returns {Promise<{authority: string|null, isAuthority: boolean, reason: string}>}
 *   `authority` : base absolue de l'autorité (jamais un chemin).
 *   `isAuthority` : cette instance stocke-t-elle elle-même ?
 */
export async function resolveMediaAuthority() {
  const canonique = await adresseCanonique();
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
 * ── CE SERVICE DÉCIDE ; IL N'ÉMET PAS ───────────────────────────────────────
 * Il ouvrait sa propre socket. Un service métier qui parle réseau est un
 * second chemin de sortie : personne ne le cherche là, et rien n'empêche qu'un
 * troisième apparaisse ailleurs. Le transport vit désormais dans
 * `bridge/MediaAuthorityClient.js`, seul fichier autorisé à parler à une autre
 * instance du Panel — exactement comme `ProjectBridgeClient.js` est le seul à
 * parler aux projets.
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
  return new MediaAuthorityClient({ baseUrl: authority }).relay(chemin, { method, headers, body });
}

export default { resolveMediaAuthority, relayToAuthority };
