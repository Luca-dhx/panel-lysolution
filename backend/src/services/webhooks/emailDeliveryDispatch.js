// LE CHEMIN RETOUR — d'un événement Brevo jusqu'au bon projet (L8.4).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Retour de livraison ».
//
// ── POURQUOI CE MODULE NE POUVAIT PAS ATTENDRE ──────────────────────────────
//
// Après bascule, les envois partent du compte Brevo DU PANEL. Or les webhooks
// de livraison suivent le COMPTE : les `delivered` / `bounced` n'atterrissent
// plus chez le projet, ils arrivent ici. Sans ce module, le suivi de livraison
// d'un projet resterait éternellement sur « envoyé » — une perte silencieuse,
// c'est-à-dire la pire. Émission et retour partent donc ensemble, ou pas.
//
// ── LE CORPS DU WEBHOOK NE DÉSIGNE JAMAIS LE PROJET ─────────────────────────
//
// Le destinataire de l'événement est retrouvé par l'IDENTIFIANT DE MESSAGE que
// NOUS avons persisté à l'émission, dans le registre d'opérations. Un `projectId`
// lu dans la charge utile serait une proposition d'un tiers : ce serait le
// chemin par lequel quelqu'un ferait router ses événements vers le projet de
// son choix.
//
// ── CE QUI EST PROJETÉ, ET RIEN D'AUTRE ─────────────────────────────────────
//
// Deux verbes métier, parce que deux seulement changent un état lu par un
// utilisateur : livré, et non livré. Projeter tout le vocabulaire Brevo « par
// principe » remplirait le journal durable d'événements que personne ne
// consomme — et chaque champ inutile est une donnée personnelle de plus à
// justifier.
import logger from '../../utils/logger.js';
import { emitChange } from '../sync/syncCore.service.js';
import { findByProviderMessageId } from '../capabilities/operationRegistry.js';
import { PANEL_SELF_SCOPE } from '../capabilities/invocationContext.js';
import { applyDeliveryEvent } from '../email/panelEmailSenderTest.service.js';
import { applyPasswordResetDeliveryEvent } from '../auth/panelPasswordReset.service.js';
import {
  normalizeBrevoEvent,
  parseEventDate,
  BREVO_EVENT_TYPES,
} from '../integratedApi/brevo/brevoEventMapping.js';
import { normalizeProviderMessageId } from '../integratedApi/brevo/brevoTransport.js';

/** Les seuls verbes que le parc consomme réellement. Fermé, et volontairement. */
export const DELIVERY_EVENTS = Object.freeze({
  DELIVERED: 'EMAIL_DELIVERED',
  BOUNCED: 'EMAIL_BOUNCED',
});

/** Type d'entité du journal durable — le projet s'y abonne. */
export const DELIVERY_ENTITY_TYPE = 'EMAIL_DELIVERY_EVENT';

/**
 * Traduit un événement Brevo en verbe métier, ou rend `null`.
 *
 * `null` n'est pas un échec : c'est la réponse normale pour les ouvertures,
 * les clics et les différés. Les faire remonter obligerait chaque projet à
 * filtrer un flux qu'il n'a pas demandé.
 */
export function toBusinessEvent(canonical) {
  switch (canonical) {
    case BREVO_EVENT_TYPES.DELIVERED:
      return DELIVERY_EVENTS.DELIVERED;
    // Un rebond dur, un rebond souple, un blocage et une adresse invalide
    // aboutissent au même constat pour un utilisateur : le message n'est pas
    // arrivé. La nuance reste dans `reason`, pour qui veut la lire.
    case BREVO_EVENT_TYPES.HARD_BOUNCE:
    case BREVO_EVENT_TYPES.SOFT_BOUNCE:
    case BREVO_EVENT_TYPES.BLOCKED:
    case BREVO_EVENT_TYPES.INVALID:
    case BREVO_EVENT_TYPES.ERROR:
      return DELIVERY_EVENTS.BOUNCED;
    default:
      return null;
  }
}

/**
 * Achemine un événement de livraison vers le projet qui a demandé l'envoi.
 *
 * Appelé APRÈS l'idempotence de réception (L5.1) : un rejeu du fournisseur
 * n'arrive jamais jusqu'ici, donc le journal durable ne peut pas contenir deux
 * fois le même fait.
 *
 * NE LÈVE JAMAIS. Un endpoint public qui lève produit une 500, et une 500 fait
 * rejouer le fournisseur en boucle.
 *
 * @returns {Promise<{dispatched: boolean, reason?: string, projectId?: string}>}
 */
export async function dispatchDeliveryEvent({ provider, environment, payload, eventType }) {
  if (String(provider).toUpperCase() !== 'BREVO') {
    return { dispatched: false, reason: 'PROVIDER_NOT_DISPATCHED' };
  }

  const { canonical } = normalizeBrevoEvent(eventType ?? payload?.event ?? '');
  const businessEvent = toBusinessEvent(canonical);
  if (!businessEvent) return { dispatched: false, reason: 'EVENT_NOT_PROJECTED' };

  /**
   * LA CORRÉLATION — sous forme canonique, et c'est indispensable.
   *
   * Brevo livre le même identifiant tantôt `<abc@bar>`, tantôt `abc@bar`. Le
   * chercher sous sa graphie brute ne retrouverait l'opération qu'une fois sur
   * deux, et l'événement serait perdu sans que rien ne le signale.
   */
  const providerMessageId = normalizeProviderMessageId(
    payload?.['message-id'] ?? payload?.messageId ?? '',
  );
  if (!providerMessageId) return { dispatched: false, reason: 'NO_MESSAGE_ID' };

  const operation = await findByProviderMessageId({ provider, environment, providerMessageId });
  if (!operation) {
    /**
     * Aucune opération connue : l'e-mail n'a pas été envoyé par le plan de
     * contrôle. C'est le cas NORMAL pendant la coexistence — un projet envoie
     * encore par son propre chemin, sur son propre compte. On ne cherche pas
     * plus loin, et surtout on n'invente pas de destinataire.
     */
    return { dispatched: false, reason: 'NO_MATCHING_OPERATION' };
  }

  const occurredAt = parseEventDate(payload);

  /**
   * L'ENVOI VENAIT-IL DU PANEL LUI-MÊME ? (R10.4)
   *
   * L'e-mail de test de l'expéditeur global emprunte la chaîne réelle, donc il
   * produit un vrai `delivered`. Mais il n'appartient à AUCUN projet : le
   * pousser sur le pont l'adresserait à un destinataire (`__panel_self__`) qui
   * n'existe pas, et le fait serait perdu — c'est-à-dire que l'écran de test
   * resterait sur « accepté », la moitié de la réponse qui ne prouve rien.
   *
   * On le pose donc là où il sera lu, et on s'arrête : un événement du Panel
   * n'a rien à faire dans le journal durable d'un projet.
   */
  if (operation.projectId === PANEL_SELF_SCOPE) {
    const apply =
      String(operation.templateCode ?? '') === 'PASSWORD_RESET_REQUEST'
        ? applyPasswordResetDeliveryEvent
        : applyDeliveryEvent;
    const applied = await apply({
      operationId: operation.operationId,
      event: businessEvent,
      providerEvent: canonical,
      occurredAt: occurredAt ? occurredAt.toISOString() : null,
      reason: businessEvent === DELIVERY_EVENTS.BOUNCED ? payload?.reason ?? null : null,
    });
    logger.info(
      `[email] ${businessEvent} rattaché au test d’expédition du Panel `
      + `(opération ${operation.operationId}).`,
    );
    return { dispatched: applied.applied, scope: 'PANEL_SELF', event: businessEvent };
  }

  await emitChange({
    entityType: DELIVERY_ENTITY_TYPE,
    /**
     * L'IDENTITÉ DE L'ENTITÉ EST L'OPÉRATION, PAS LE MESSAGE.
     *
     * ══ CE QUE CE CHOIX CORRIGE ═══════════════════════════════════════════
     *
     * Le contrat de pont impose `entityId: uuid`. Un identifiant de message
     * Brevo (`msg-42@brevo`) n'en est pas un : la page entière était rejetée
     * en `BRIDGE_INVALID_PAYLOAD`, et AUCUN événement n'atteignait le projet.
     * Le Panel émettait, le projet n'appliquait rien, et rien ne le disait.
     *
     * ══ ET C'EST AUSSI LE BON IDENTIFIANT ═════════════════════════════════
     *
     * L'entité dont on parle est la LIVRAISON, pas le message du fournisseur.
     * `operationId` est le `deliveryId` du projet : il est un UUID, il existe
     * AVANT l'envoi, et le projet le connaît sans avoir eu besoin de recevoir
     * la réponse d'émission. C'est précisément ce qui rend la course
     * « webhook avant réponse » sans effet.
     *
     * `providerMessageId` reste dans la charge utile : il sert de repli de
     * corrélation, jamais d'identité.
     */
    entityId: operation.operationId,
    /**
     * CHARGE UTILE MINIMALE. Ni adresse, ni sujet, ni contenu : le projet les
     * détient déjà, et les recopier ferait du journal durable du Panel un
     * second exemplaire de données personnelles à protéger et à purger.
     */
    payload: {
      event: businessEvent,
      providerMessageId,
      operationId: operation.operationId,
      /** Le libellé BRUT du fournisseur — conservé pour le forensic. */
      providerEvent: canonical,
      occurredAt: occurredAt ? occurredAt.toISOString() : null,
      /** Motif lisible d'un non-acheminement, quand le fournisseur en donne un. */
      reason: businessEvent === DELIVERY_EVENTS.BOUNCED
        ? String(payload?.reason ?? '').slice(0, 200) || null
        : null,
    },
    // Le destinataire est NOMMÉ : cet événement ne concerne qu'un projet.
    audience: operation.projectId,
  });

  logger.info(
    `[email] ${businessEvent} acheminé vers ${operation.projectId} `
    + `(opération ${operation.operationId}).`,
  );

  return { dispatched: true, projectId: operation.projectId, event: businessEvent };
}

export default { dispatchDeliveryEvent, toBusinessEvent, DELIVERY_EVENTS, DELIVERY_ENTITY_TYPE };
