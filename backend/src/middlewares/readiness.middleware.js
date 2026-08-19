/**
 * LA GARDE DE DISPONIBILITÉ — une route métier ne répond que si elle le peut.
 *
 * ══ POURQUOI UN REFUS EXPLICITE VAUT MIEUX QU'UNE ATTENTE ═══════════════════
 *
 * Sans cette garde, une requête arrivée pendant l'amorçage part en tampon chez
 * Mongoose, attend dix secondes, puis échoue. L'utilisateur voit une interface
 * figée, puis une erreur qui ne dit rien. Avec elle, il reçoit immédiatement un
 * `503` portant un code stable — l'interface sait alors qu'il faut ATTENDRE et
 * réessayer, pas se déconnecter.
 *
 * ══ 503, ET SURTOUT PAS 401 ═════════════════════════════════════════════════
 *
 * C'est l'invariant central du lot. Un service qui démarre n'a AUCUNE opinion
 * sur la validité d'une session : il n'a pas pu la vérifier. Répondre 401 —
 * ou laisser une erreur de base remonter en 500 que le client interprète — fait
 * détruire une session parfaitement valide. Le seul code honnête est « je ne
 * peux pas répondre maintenant ».
 *
 * ══ CE QUI RESTE JOIGNABLE ══════════════════════════════════════════════════
 *
 * Les sondes, et elles seules (`/livez`, `/readyz`). Elles n'ont aucune
 * dépendance : les gater les rendrait indisponibles exactement quand elles
 * servent à diagnostiquer l'indisponibilité.
 */
import { isReady, unavailabilityReason } from '../services/health/readiness.service.js';

/**
 * Chemins TOUJOURS servis, quel que soit l'état du service.
 *
 * `/health` y figure avec les deux nouvelles sondes, et c'est un choix de
 * COMPATIBILITÉ : il est déjà interrogé par nginx et par l'étape de contrôle du
 * déploiement. Le gater changerait, sans prévenir, le sens d'une réponse dont
 * d'autres systèmes dépendent. Sa sémantique reste celle qu'elle a toujours eue
 * — « ce process répond, et voici l'état qu'il croit avoir » — et c'est
 * `/readyz` qui porte désormais la question de l'aptitude réelle.
 */
const SONDES = ['/livez', '/readyz', '/health'];

function estUneSonde(url) {
  const chemin = String(url || '').split('?')[0];
  return SONDES.some((s) => chemin === s || chemin.startsWith(`${s}/`));
}

/**
 * Refuse proprement tant que le service n'est pas prêt.
 *
 * `Retry-After` n'est pas décoratif : il dit au client — navigateur, proxy,
 * fournisseur de webhook — dans combien de temps réessayer. Sans lui, chacun
 * choisit sa propre cadence, et un backend qui démarre reçoit une rafale.
 */
export function requireServiceReady(req, res, next) {
  if (isReady() || estUneSonde(req.originalUrl ?? req.url)) return next();

  const raison = unavailabilityReason();
  res.set('Retry-After', '2');
  res.set('Cache-Control', 'no-store');
  return res.status(503).json({
    success: false,
    code: raison.code,
    message: raison.message,
    // L'interface de reconnexion lit ce drapeau pour se distinguer d'un refus
    // d'authentification : « réessaie » n'est pas « reconnecte-toi ».
    details: { retryable: true, sessionValid: true },
  });
}

export default requireServiceReady;
