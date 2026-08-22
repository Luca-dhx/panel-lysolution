// LES LIGNES ÉCRITES SOUS L'ANCIEN CONTRAT — classées une fois, explicitement.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §9 bis.
//
// ══ LE PIÈGE, ET IL S'EST REFERMÉ SUR LA PILE DÉPLOYÉE ══════════════════════
//
// La nouvelle machine dit : « un `RECEIVED` ancien n'a jamais été réclamé, donc
// il est reprenable ». C'est vrai pour une ligne écrite PAR ELLE — une telle
// ligne naît `PROCESSING`, et ne peut être `RECEIVED` que par accident.
//
// Ce n'est PAS vrai pour les lignes antérieures. Sous l'ancien contrat,
// `RECEIVED` était l'état de fin : la ligne était écrite, les effets suivaient
// en best-effort, et rien ne repassait jamais dessus. Les relire avec la
// grammaire nouvelle revient à déclarer abandonné TOUT L'HISTORIQUE.
//
// Mesure au premier démarrage après déploiement :
//
//     39 événements réclamés, échoués, et repartis pour un tour
//     BREVO 30 · OPENSIGN 9 — aucun n'était en défaut
//
// ══ POURQUOI ON NE LES REJOUE PAS ═══════════════════════════════════════════
//
// Parce qu'on n'a AUCUNE preuve dans un sens ni dans l'autre, et que les deux
// erreurs n'ont pas le même prix :
//
//   les rejouer      → réexécuter des mois d'événements, réécrire des
//                      appartenances, réémettre des acheminements vers les
//                      projets. Un rattrapage dont personne ne peut prédire la
//                      portée n'est pas un rattrapage, c'est un incident.
//   les classer      → on honore la sémantique sous laquelle ils ont été
//                      écrits, et on l'ÉCRIT. La garantie neuve s'applique à
//                      partir d'ici.
//
// La migration ne prétend donc pas que ces lignes ont été traitées : elle dit
// qu'elles ont été écrites par un code pour qui `RECEIVED` signifiait « reçu et
// pris en charge », et qu'on ne les rouvre pas. C'est une décision datée, pas
// une supposition tacite.
//
// ══ ADDITIVE, ET SANS PURGE ═════════════════════════════════════════════════
//
// Aucune ligne n'est supprimée. Les `PROCESSED` existants restent terminaux ;
// les autres états hérités sont nommés ci-dessous, un par un.
import logger from '../../utils/logger.js';
import PanelProviderWebhookEvent, {
  WEBHOOK_EVENT_STATUS,
} from '../../models/PanelProviderWebhookEvent.model.js';

/**
 * Le marqueur porté par les lignes classées. Il vit dans `lastError.code`
 * faute d'un champ plus juste — mais son `retryable: false` dit l'essentiel :
 * cette ligne ne repartira pas dans le balayage.
 */
export const LEGACY_MARKER = 'LEGACY_RECEIVED_BEFORE_LEASE';

/**
 * Classe les lignes héritées. Idempotente : un second passage n'en trouve
 * aucune, puisque celles qu'elle a traitées ne sont plus `RECEIVED`.
 *
 * @returns {Promise<{legacy: number, unsupported: number}>}
 */
export async function migrateLegacyWebhookEvents({ now = new Date() } = {}) {
  /**
   * ── COMMENT ON RECONNAÎT UNE LIGNE HÉRITÉE ──────────────────────────────
   *
   * Elle n'a JAMAIS été réclamée par la nouvelle machine : pas de compteur de
   * tentatives, pas de bail. Une ligne neuve laissée en `RECEIVED` par accident
   * n'existe pas — la réclamation la crée directement en `PROCESSING`.
   */
  const legacy = await PanelProviderWebhookEvent.updateMany(
    {
      status: WEBHOOK_EVENT_STATUS.RECEIVED,
      $or: [{ processingAttempts: { $exists: false } }, { processingAttempts: 0 }],
      leaseOwner: null,
    },
    {
      $set: {
        status: WEBHOOK_EVENT_STATUS.PROCESSED,
        processedAt: now.toISOString(),
        processingAttempts: 0,
        lastError: {
          code: LEGACY_MARKER,
          message: 'écrite avant le bail : « RECEIVED » y valait fin de traitement',
          retryable: false,
          at: now.toISOString(),
        },
      },
    },
  );

  /**
   * ── ET LES LIGNES QUE LE BALAYAGE A DÉJÀ ABÎMÉES ────────────────────────
   *
   * Le premier démarrage après déploiement a réclamé des événements Brevo et
   * OpenSign, échoué sur `WEBHOOK_REPLAY_UNSUPPORTED`, et les a laissés
   * `FAILED` — donc reprenables, donc repris au passage suivant. Ils marchaient
   * vers `DEAD_LETTER` et vers autant d'alertes qui n'auraient décrit aucun
   * incident.
   *
   * Le code d'erreur est sans ambiguïté : seul le balayage l'écrit, et il ne
   * l'écrit plus. On les rend à leur état de fin.
   */
  const unsupported = await PanelProviderWebhookEvent.updateMany(
    { status: WEBHOOK_EVENT_STATUS.FAILED, 'lastError.code': 'WEBHOOK_REPLAY_UNSUPPORTED' },
    {
      $set: {
        status: WEBHOOK_EVENT_STATUS.PROCESSED,
        processedAt: now.toISOString(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: {
          code: LEGACY_MARKER,
          message: 'réclamée à tort par un balayage qui ne pouvait pas la rejouer',
          retryable: false,
          at: now.toISOString(),
        },
      },
    },
  );

  const total = (legacy.modifiedCount ?? 0) + (unsupported.modifiedCount ?? 0);
  if (total > 0) {
    logger.warn(
      `[webhooks] ${legacy.modifiedCount ?? 0} événement(s) hérité(s) classé(s) PROCESSED `
      + `(« RECEIVED » valait fin de traitement avant le bail)`
      + `${unsupported.modifiedCount ? `, et ${unsupported.modifiedCount} réclamé(s) à tort remis en état` : ''}.`,
    );
  }
  return { legacy: legacy.modifiedCount ?? 0, unsupported: unsupported.modifiedCount ?? 0 };
}

export default { migrateLegacyWebhookEvents, LEGACY_MARKER };
