// UNE NOUVELLE TENTATIVE, DÉCLENCHÉE PAR UN HUMAIN (mini-lot « retry »).
//
// ══ CE QUE CE SERVICE EST, ET CE QU'IL N'EST PAS ════════════════════════════
//
// Il est le GESTE d'un exploitant : « retente maintenant ». Il n'est pas un
// ordonnanceur, ne programme rien, et ne crée aucune récurrence.
//
// La doctrine du parc — « Stripe est l'unique ordonnanceur des tentatives de
// collecte » — interdit d'écrire une boucle qui retenterait en parallèle de
// celle de Stripe : deux calendriers sur la même facture, c'est le double
// débit. Elle n'interdit pas de déclencher UNE tentative à la main, quand un
// exploitant sait quelque chose que Stripe ignore : le client vient d'appeler
// pour dire que sa carte est réapprovisionnée, et personne n'a envie
// d'attendre la prochaine tentative programmée dans quatre jours.
//
// La différence est celle entre un réveil et un coup d'œil à sa montre.
//
// ══ CE SERVICE NE MARQUE JAMAIS « PAYÉ » ════════════════════════════════════
//
// Il RÉCLAME ; il ne CONSTATE pas. Que la tentative aboutisse ou non, c'est le
// webhook de Stripe qui l'apprendra au Panel, par le même chemin que toutes les
// autres tentatives — celles que Stripe a programmées lui-même. Une tentative
// manuelle suit donc EXACTEMENT la même machine métier qu'une automatique :
// même projection de revenu, même résolution d'incident, mêmes e-mails.
//
// Écrire l'issue ici créerait une seconde autorité sur l'état de la créance, et
// les deux finiraient par diverger.
import ApiError from '../../../utils/ApiError.js';
import logger from '../../../utils/logger.js';
import { PanelPaymentDefault, PAYMENT_DEFAULT_STATUS } from '../../../models/PanelPaymentDefault.model.js';
import { invokeCapability } from '../../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../capabilities/invocationContext.js';
import { getProjectOrThrow } from '../../registry/projectRegistry.service.js';

const CAPABILITY = 'billing.invoice.retry';

/**
 * LES ÉTATS QUI AUTORISENT UNE TENTATIVE MANUELLE.
 *
 * `RESOLVED` et `CLOSED` en sont exclus : le premier est payé, le second est
 * abandonné. Retenter l'un ou l'autre serait soit un second débit, soit une
 * relance sur une créance qu'on a cessé de réclamer.
 *
 * `GRACE_EXPIRED` en fait partie, et c'est délibéré : la grâce est une
 * politique commerciale de SUSPENSION, pas une date après laquelle on cesse
 * d'essayer d'être payé. Un site coupé peut parfaitement rouvrir si le
 * paiement passe enfin.
 */
const ETATS_RETENTABLES = Object.freeze([
  PAYMENT_DEFAULT_STATUS.OPEN,
  PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED,
]);

/**
 * CET INCIDENT PEUT-IL RECEVOIR UNE NOUVELLE TENTATIVE ?
 *
 * Rendu à l'écran pour qu'il n'affiche le bouton que lorsqu'il servira. Ce
 * n'est PAS la garde : celle-ci vit dans `retryPaymentDefault`, et surtout dans
 * l'autorité Stripe qui relit la facture avant d'agir. Un écran décide de ce
 * qu'il montre ; il ne décide jamais de ce qui est permis.
 *
 * @returns {{retryable: boolean, reason: string|null}}
 */
export function describeRetryEligibility(incident) {
  if (!incident) return { retryable: false, reason: 'INCIDENT_UNKNOWN' };
  if (!ETATS_RETENTABLES.includes(incident.status)) {
    return { retryable: false, reason: 'INCIDENT_NOT_RETRYABLE' };
  }
  if (!incident.invoiceId) return { retryable: false, reason: 'NO_PROVIDER_INVOICE' };
  if (!(Number(incident.amountDueCents ?? 0) > 0)) {
    return { retryable: false, reason: 'NOTHING_DUE' };
  }
  return { retryable: true, reason: null };
}

/**
 * DEMANDE À STRIPE DE RETENTER LA COLLECTE DE CETTE CRÉANCE.
 *
 * ══ POURQUOI L'INCIDENT NE SUFFIT PAS À DÉCIDER ════════════════════════════
 *
 * L'incident du Panel est un observatoire : il reflète le dernier webhook reçu.
 * Entre-temps, Stripe a pu retenter et réussir. La décision finale appartient
 * donc à l'autorité Stripe, qui RELIT la facture à l'instant du clic — ici, on
 * ne fait qu'écarter tôt les cas évidents, pour éviter un aller-retour et pour
 * rendre un motif lisible.
 *
 * ══ L'IDEMPOTENCE N'EST PAS ICI NON PLUS ═══════════════════════════════════
 *
 * Elle est portée par l'identité d'acte, dérivée de la facture ET de son nombre
 * de tentatives. Deux clics sur le même état rejouent le même acte ; la
 * passerelle refuse le second s'il arrive pendant que le premier vole encore.
 *
 * @param {{paymentDefaultId: string, actor?: object}} args
 */
export async function retryPaymentDefault({ paymentDefaultId, actor = {} }) {
  const incident = await PanelPaymentDefault.findOne({ paymentDefaultId }).lean();
  if (!incident) {
    throw ApiError.notFound('PANEL_PAYMENT_DEFAULT_UNKNOWN', 'Cet impayé est introuvable.');
  }

  const verdict = describeRetryEligibility(incident);
  if (!verdict.retryable) {
    /**
     * 409, et non 400 : la requête est bien formée. C'est l'ÉTAT de la créance
     * qui interdit l'action, et il n'y a rien à corriger dans la demande.
     */
    throw ApiError.conflict(
      'PANEL_PAYMENT_NOT_RETRYABLE',
      messagePour(verdict.reason),
      { code: 'PAYMENT_NOT_RETRYABLE', reason: verdict.reason, status: incident.status },
    );
  }

  const panelProject = await getProjectOrThrow(incident.projectId);

  logger.info(
    `[finance] nouvelle tentative demandée sur l’impayé ${paymentDefaultId} `
    + `(${incident.projectId}) par ${actor.email ?? 'un exploitant'}.`,
  );

  const resultat = await invokeCapability({
    code: CAPABILITY,
    panelProject,
    /** Le Panel agit POUR le projet, sans que le projet demande rien. */
    source: INVOCATION_SOURCES.PANEL_INTERNAL,
    payload: { invoiceId: incident.invoiceId },
  });

  /**
   * On rend l'état RELU chez Stripe, sans rien en déduire. Si la tentative a
   * abouti, c'est le webhook qui résoudra l'incident — pas cette réponse.
   */
  return {
    requested: true,
    invoice: resultat?.result ?? null,
    /**
     * L'incident tel qu'il est ENCORE : inchangé, et c'est normal. Le dire
     * évite qu'un écran conclue à un échec parce que rien n'a bougé dans la
     * seconde qui suit.
     */
    incidentStatus: incident.status,
  };
}

/** Le motif, en français, pour un écran — jamais un code brut à l'utilisateur. */
function messagePour(reason) {
  switch (reason) {
    case 'INCIDENT_NOT_RETRYABLE':
      return 'Cet impayé est clos : aucune nouvelle tentative n’est possible.';
    case 'NO_PROVIDER_INVOICE':
      return 'Aucune facture fournisseur n’est rattachée à cet impayé.';
    case 'NOTHING_DUE':
      return 'Cet impayé ne présente plus aucun montant dû.';
    default:
      return 'Cet impayé ne peut pas recevoir de nouvelle tentative.';
  }
}

export default { describeRetryEligibility, retryPaymentDefault };
