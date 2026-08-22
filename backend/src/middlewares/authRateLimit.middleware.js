// RALENTIR LE FORÇAGE, SANS BLOQUER QUI SE TROMPE DE MOT DE PASSE.
//
// ══ CE QUE CE MIDDLEWARE PROTÈGE ════════════════════════════════════════════
//
// Les points où des IDENTIFIANTS sont réellement vérifiés. Pas les lectures,
// pas les rafraîchissements de jeton : ceux-là ne se devinent pas, et les
// limiter ferait payer à un utilisateur normal une protection qui ne le
// concerne pas.
//
// ══ DEUX SEAUX, ET C'EST LE POINT ═══════════════════════════════════════════
//
//     par IP        20 tentatives / 15 min
//     par IDENTITÉ   8 tentatives / 15 min
//
// Chacun seul est contournable, et de façon symétrique :
//
//   · par IP seule       — une attaque distribuée sur mille adresses passe
//                          sous le radar ; et un bureau derrière un NAT se
//                          bloque tout seul dès que trois personnes se
//                          trompent le même matin ;
//   · par identité seule — un attaquant balaie mille comptes différents sans
//                          jamais remplir un seul seau.
//
// Les deux doivent passer. Le plus contraignant décide.
//
// ══ AUCUN VERROUILLAGE DE COMPTE ════════════════════════════════════════════
//
// Une fenêtre glissante qui expire d'elle-même, jamais un blocage permanent.
// Un verrou permanent transforme une nuisance en déni de service : il suffirait
// de connaître l'adresse d'un administrateur pour lui fermer la porte.
//
// Une connexion RÉUSSIE efface le seau d'identité : quelqu'un qui retrouve son
// mot de passe au sixième essai ne doit pas rester à deux tentatives du blocage
// pour le quart d'heure suivant.
//
// ══ AUCUNE ÉNUMÉRATION INTRODUITE ═══════════════════════════════════════════
//
// Le seau est nourri par l'identité SOUMISE, existante ou non. Un attaquant
// obtient donc exactement la même réponse dans les deux cas — et le compteur ne
// lui apprend rien qu'il ne sache déjà : ce qu'il vient lui-même d'envoyer.
import { createHash } from 'node:crypto';

import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import PanelAuthAttempt from '../models/PanelAuthAttempt.model.js';

/** La fenêtre, et les deux plafonds. Un seul endroit, pour qu'ils se lisent. */
export const AUTH_RATE_LIMITS = Object.freeze({
  windowMs: 15 * 60 * 1000,
  perIp: 20,
  perIdentity: 8,
});

export const AUTH_RATE_LIMITED = 'AUTH_RATE_LIMITED';

/**
 * L'IDENTITÉ EST HACHÉE, ET LE SEL EST FIXE.
 *
 * Fixe parce qu'il faut retrouver le même seau d'une requête à l'autre — un sel
 * aléatoire rendrait chaque tentative unique, donc le compteur inutile. Haché
 * quand même, parce que ce compteur n'a aucune raison de constituer la liste
 * des adresses que l'on tente de forcer.
 */
function empreinte(valeur) {
  return createHash('sha256').update(String(valeur ?? '').trim().toLowerCase()).digest('hex').slice(0, 32);
}

/**
 * L'ADRESSE DU CLIENT — celle qu'Express a résolue, jamais un en-tête brut.
 *
 * `app.set('trust proxy', 1)` fait qu'Express lit le DERNIER maillon de
 * `X-Forwarded-For`, c'est-à-dire celui que notre nginx a écrit. Lire l'en-tête
 * nous-mêmes reviendrait à croire le premier maillon — fourni par le client —
 * et n'importe qui obtiendrait une IP neuve à chaque requête.
 */
function adresse(req) {
  return req.ip || req.socket?.remoteAddress || 'inconnue';
}

/**
 * INCRÉMENTE UN SEAU, ET DIT S'IL DÉBORDE.
 *
 * `findOneAndUpdate` avec `upsert` : l'incrément est ATOMIQUE. Une lecture
 * suivie d'une écriture laisserait passer autant de tentatives simultanées
 * qu'il y a de requêtes en vol — exactement ce qu'un attaquant fait.
 */
async function consommer(key, plafond, maintenant) {
  const finFenetre = new Date(maintenant.getTime() + AUTH_RATE_LIMITS.windowMs);

  /**
   * On ne recrée le seau que s'il a EXPIRÉ. Le filtre porte donc sur la date :
   * un seau vivant est incrémenté, un seau mort est remplacé, et les deux cas
   * tiennent en une écriture.
   */
  const vivant = await PanelAuthAttempt.findOneAndUpdate(
    { key, expiresAt: { $gt: maintenant } },
    { $inc: { count: 1 }, $set: { lastAttemptAt: maintenant } },
    { new: true },
  ).lean();

  if (vivant) {
    return {
      depasse: vivant.count > plafond,
      retryAfterSeconds: Math.max(1, Math.ceil((new Date(vivant.expiresAt) - maintenant) / 1000)),
    };
  }

  await PanelAuthAttempt.findOneAndUpdate(
    { key },
    { $set: { count: 1, expiresAt: finFenetre, lastAttemptAt: maintenant } },
    { upsert: true },
  );
  return { depasse: false, retryAfterSeconds: Math.ceil(AUTH_RATE_LIMITS.windowMs / 1000) };
}

/** Efface un seau — appelé sur une connexion réussie. */
export async function oublierTentatives(scope, identite) {
  if (!identite) return;
  await PanelAuthAttempt.deleteOne({ key: `${scope}:id:${empreinte(identite)}` }).catch(() => null);
}

/**
 * LE MIDDLEWARE.
 *
 * @param {{scope: string, identityFrom?: (req: object) => string|null}} options
 *   `scope` sépare les surfaces : trop de tentatives de connexion ne doivent pas
 *   fermer la porte de la réinitialisation de mot de passe, qui est un autre
 *   geste avec un autre risque.
 */
export function authRateLimit({ scope, identityFrom = (req) => req.body?.email ?? null }) {
  return async function limiteur(req, res, next) {
    const maintenant = new Date();
    const ip = adresse(req);
    const identite = identityFrom(req);

    /**
     * Les deux seaux sont consommés MÊME si le premier déborde déjà.
     *
     * Autrement, un attaquant saturant volontairement le seau d'IP masquerait
     * ses tentatives sur une identité — celle-ci ne serait jamais comptée, et
     * repartirait intacte depuis une autre adresse.
     */
    let verdicts;
    try {
      verdicts = await Promise.all([
        consommer(`${scope}:ip:${empreinte(ip)}`, AUTH_RATE_LIMITS.perIp, maintenant),
        identite
          ? consommer(`${scope}:id:${empreinte(identite)}`, AUTH_RATE_LIMITS.perIdentity, maintenant)
          : Promise.resolve({ depasse: false, retryAfterSeconds: 0 }),
      ]);
    } catch (err) {
      /**
       * ── LA BASE EST MUETTE : ON LAISSE PASSER, ET ON LE DIT ────────────────
       *
       * Refuser toutes les connexions parce que le compteur est illisible
       * transformerait une gêne en panne totale d'authentification. Le risque
       * inverse — quelques tentatives non comptées pendant une indisponibilité
       * de base — est incomparablement plus faible, et la base est de toute
       * façon nécessaire pour vérifier un mot de passe.
       */
      logger.warn(`[auth] compteur de tentatives illisible (${scope}) : ${err?.message ?? 'erreur inconnue'}.`);
      return next();
    }

    const bloquant = verdicts.find((v) => v.depasse);
    if (!bloquant) return next();

    const retryAfterSeconds = Math.max(...verdicts.filter((v) => v.depasse).map((v) => v.retryAfterSeconds));
    res.set('Retry-After', String(retryAfterSeconds));

    /**
     * 429, ET SURTOUT PAS 401.
     *
     * Un 401 dirait « identifiants invalides » : l'appelant réessaierait, et
     * une interface honnête afficherait « mot de passe incorrect » à quelqu'un
     * qui a peut-être tapé le bon. Le 429 dit la vérité — « pas maintenant » —
     * et c'est la seule réponse sur laquelle un client peut agir correctement.
     *
     * Le message ne dit ni combien de tentatives restent, ni si l'adresse
     * existe : il n'apprend rien qui aide à forcer.
     */
    return next(new ApiError(
      429,
      AUTH_RATE_LIMITED,
      'Trop de tentatives de connexion. Réessayez dans quelques minutes.',
      { retryAfterSeconds },
    ));
  };
}

export default authRateLimit;
