// OÙ L'ON A LE DROIT DE RENVOYER LE NAVIGATEUR (L12.B-UI).
//
// docs/auth/PANEL_FEDERATED_DEV_IDENTITY_IMPLEMENTATION.md §« PANEL REDIRECT ».
//
// ══ LE DANGER, ÉNONCÉ SANS DÉTOUR ═══════════════════════════════════════════
//
// Le parcours fédéré se termine par une redirection qui TRANSPORTE UNE
// ASSERTION. Si l'adresse de retour venait de l'appelant sans contrôle, il
// suffirait de forger :
//
//     /federation/authorize?projectId=…&returnUrl=https://malveillant.test/vol
//
// et d'y envoyer un développeur déjà connecté au Panel. Le Panel émettrait une
// assertion parfaitement valide — pour un projet auquel ce développeur a
// réellement accès — et la livrerait à l'attaquant. Aucune signature n'aurait
// été forcée : on la lui aurait DONNÉE.
//
// C'est la vulnérabilité classique de redirection ouverte, ici avec un jeton
// dans l'URL. Elle est bien pire qu'une simple redirection ouverte, parce que
// le butin voyage AVEC la victime.
//
// ══ LA RÈGLE ═══════════════════════════════════════════════════════════════
//
// L'origine de retour doit être une origine que LE PANEL connaît déjà pour CE
// projet — c'est-à-dire une adresse qu'un opérateur a enregistrée, pas une
// adresse qu'un lien propose. Rien d'autre n'est accepté. En l'absence
// d'origine connue, on refuse : mieux vaut un parcours qui ne part pas qu'un
// parcours qui arrive ailleurs.
import PanelProjectDestination, {
  DESTINATION_STATUS,
} from '../../models/PanelProjectDestination.model.js';
import PanelProject from '../../models/PanelProject.model.js';

export const RETURN_URL_ERRORS = Object.freeze({
  MALFORMED: 'FEDERATION_RETURN_URL_MALFORMED',
  INSECURE: 'FEDERATION_RETURN_URL_INSECURE',
  UNKNOWN_ORIGIN: 'FEDERATION_RETURN_URL_UNKNOWN_ORIGIN',
  NO_KNOWN_ORIGIN: 'FEDERATION_RETURN_URL_NO_KNOWN_ORIGIN',
});

/**
 * `http` n'est toléré que sur la boucle locale.
 *
 * Une assertion qui voyage en clair sur un réseau est une assertion lue. En
 * développement, tout se passe sur `localhost` — le tolérer là et nulle part
 * ailleurs permet de travailler sans ouvrir la porte en production.
 */
function schemeAcceptable(url) {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
}

/**
 * LES ORIGINES CONNUES D'UN PROJET.
 *
 * Trois sources, toutes enregistrées par un opérateur ou annoncées par le
 * projet lui-même au fil de ses déploiements :
 *
 *   · l'URL du MANAGER de sa destination active — le cas nominal ;
 *   · celles de ses destinations non retirées — un projet qui vient de migrer
 *     peut encore renvoyer depuis l'ancienne pendant la bascule ;
 *   · son `publicBackendUrl` — filet pour les projets sans destination
 *     enregistrée, où manager et backend partagent l'origine.
 *
 * Aucune n'est devinée ni recomposée : ce sont des adresses que le parc
 * connaissait déjà avant que ce parcours existe.
 */
export async function knownOriginsFor(projectId) {
  const origines = new Set();

  const ajouter = (candidate) => {
    if (!candidate) return;
    try {
      origines.add(new URL(String(candidate)).origin);
    } catch {
      // Une adresse illisible en base n'est pas une raison de refuser les
      // autres : on l'ignore, elle n'autorisera simplement rien.
    }
  };

  const destinations = await PanelProjectDestination
    .find({ projectId, status: { $ne: DESTINATION_STATUS.DELETED } })
    .select('urls status')
    .lean();

  for (const destination of destinations) {
    ajouter(destination.urls?.manager);
  }

  const project = await PanelProject.findOne({ projectId }).select('runtime.publicBackendUrl').lean();
  ajouter(project?.runtime?.publicBackendUrl);

  return [...origines];
}

/**
 * VALIDE une adresse de retour pour ce projet.
 *
 * ── POURQUOI ON COMPARE DES ORIGINES, ET PAS DES PRÉFIXES ─────────────────
 *
 * Une comparaison par préfixe (`url.startsWith(connue)`) est contournable :
 * `https://manager.client.fr.malveillant.test` commence bien par
 * `https://manager.client.fr`. L'origine — schéma + hôte + port — est une
 * valeur normalisée par la plateforme, et elle ne se laisse pas préfixer.
 *
 * @returns {Promise<{valid: boolean, reasonCode?: string, url?: string}>}
 */
export async function validateReturnUrl(candidate, { projectId }) {
  let url;
  try {
    url = new URL(String(candidate ?? ''));
  } catch {
    return { valid: false, reasonCode: RETURN_URL_ERRORS.MALFORMED };
  }

  if (!schemeAcceptable(url)) {
    return { valid: false, reasonCode: RETURN_URL_ERRORS.INSECURE };
  }

  const connues = await knownOriginsFor(projectId);
  if (connues.length === 0) {
    /**
     * AUCUNE ORIGINE CONNUE : ON REFUSE, ET ON NE DEVINE PAS.
     *
     * La tentation serait d'accepter puisqu'on n'a rien à comparer. Ce serait
     * exactement la faille : un projet sans destination enregistrée
     * accepterait n'importe quelle adresse de retour.
     */
    return { valid: false, reasonCode: RETURN_URL_ERRORS.NO_KNOWN_ORIGIN };
  }

  if (!connues.includes(url.origin)) {
    return { valid: false, reasonCode: RETURN_URL_ERRORS.UNKNOWN_ORIGIN };
  }

  /**
   * ON REND UNE URL RECOMPOSÉE, PAS CELLE QU'ON A REÇUE.
   *
   * Origine + chemin, sans la query ni le fragment d'origine. Un `returnUrl`
   * portant déjà `?assertion=…` ou un fragment servirait à masquer ce qu'on
   * s'apprête à y ajouter, ou à faire fuiter le jeton dans un `Referer`
   * construit par l'appelant.
   */
  return { valid: true, url: `${url.origin}${url.pathname}` };
}

export default { RETURN_URL_ERRORS, knownOriginsFor, validateReturnUrl };
