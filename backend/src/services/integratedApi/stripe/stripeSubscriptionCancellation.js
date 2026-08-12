// RÉSILIER SANS JAMAIS RÉSILIER DEUX FOIS (L6.2G).
//
// docs/architecture/STRIPE_L6_2G_SUBSCRIPTION_CANCELLATION_CUTOVER_REPORT.md.
//
// ══ CE QUI REND CE LOT DIFFÉRENT DE TOUS LES PRÉCÉDENTS ═════════════════════
//
// Pour un paiement (L6.2B), un silence du fournisseur laissait une question
// sans réponse : la session existe-t-elle ? Et si oui, a-t-elle été payée ?
// L'état ne suffisait pas à trancher, d'où la convergence par clé
// d'idempotence, bornée par la fenêtre de Stripe.
//
// Une résiliation, elle, laisse une TRACE D'ÉTAT NON AMBIGUË :
//
//     `cancel_at_period_end`  vaut true, ou il ne le vaut pas
//     `status`                vaut `canceled`, ou il ne le vaut pas
//
// Il n'existe aucun état intermédiaire, aucune course, aucun délai de
// propagation qui rendrait la lecture trompeuse. Relire l'abonnement répond
// donc EXACTEMENT à « l'acte a-t-il eu lieu ? » — ce qu'aucune lecture ne
// pouvait faire pour un paiement.
//
// C'est ce fait, et lui seul, qui autorise ici une convergence par l'état
// plutôt que par la seule fenêtre d'idempotence. Il est vérifié avant d'agir,
// jamais supposé.
//
// ══ LES DEUX VERBES N'ONT PAS LA MÊME NATURE ════════════════════════════════
//
//   À ÉCHÉANCE   `cancel_at_period_end = true`. Un DRAPEAU, donc convergent par
//                nature : le poser deux fois donne le même état. Réversible
//                jusqu'à l'échéance, et l'accès reste ouvert d'ici là.
//
//   IMMÉDIATE    `DELETE`. Un acte TERMINAL, et Stripe REFUSE de le rejouer :
//                résilier un abonnement déjà `canceled` rend une erreur. C'est
//                précisément pourquoi la relecture d'état est indispensable —
//                sans elle, un rejeu légitime ressemblerait à un échec.
//
// ══ CE QU'ON NE FAIT JAMAIS ═════════════════════════════════════════════════
//
// Transformer une incertitude en nouvelle mutation. Si l'état ne permet pas de
// conclure — abonnement illisible, fournisseur muet — l'opération reste
// indécidable et attend un arbitrage humain.
import logger from '../../../utils/logger.js';
import { maskResourceId } from './stripeResourceBinding.js';

/* -------------------------------------------------------------------------- */
/*  LES IDENTITÉS D'ACTE                                                      */
/* -------------------------------------------------------------------------- */

/**
 * L'identité d'une résiliation — DÉRIVÉE, comme pour les verbes `ensure`.
 *
 * ══ POURQUOI LE PROJET NE LA FOURNIT PAS ════════════════════════════════════
 *
 * Un paiement peut légitimement être retenté : une session expire, une carte
 * est refusée, et la tentative suivante est un ACTE NOUVEAU qui mérite sa
 * propre identité. C'est pourquoi le projet nomme ses paiements.
 *
 * Une résiliation n'a pas cette propriété. « Résilier cet abonnement de cette
 * façon » est un acte TERMINAL et unique : il n'existe pas de seconde tentative
 * légitime, seulement des rejeux de la même intention. Laisser le projet nommer
 * l'acte lui permettrait d'en fabriquer deux — c'est-à-dire de couper deux fois
 * ce qui ne se coupe qu'une.
 *
 * L'identité porte donc le MONDE et l'ABONNEMENT, et rien d'autre. La capacité
 * n'y figure pas : elle est déjà dans la clé du registre d'opérations
 * `(projectId, capability, operationId)` et dans la dérivation de la clé
 * Stripe. Les deux verbes restent donc des actes distincts, sans que la chaîne
 * ait à le répéter.
 */
export function cancellationOperationId({ environment, subscriptionId }) {
  return `stripe-subscription-cancel:${environment}:${subscriptionId}`;
}

/* -------------------------------------------------------------------------- */
/*  LECTURE D'ÉTAT — LA PREUVE                                                */
/* -------------------------------------------------------------------------- */

/** Ce que l'état d'un abonnement dit d'une résiliation déjà demandée. */
export const CANCELLATION_STATE = Object.freeze({
  /** L'acte a eu lieu : inutile de le refaire. */
  ALREADY_DONE: 'ALREADY_DONE',
  /** L'acte n'a pas eu lieu : on peut agir. */
  NOT_DONE: 'NOT_DONE',
  /** L'état ne permet pas de conclure. On n'agit pas, on ne prétend rien. */
  INDETERMINATE: 'INDETERMINATE',
});

/**
 * L'acte demandé est-il DÉJÀ inscrit dans l'état de l'abonnement ?
 *
 * @param {object|null} subscription  l'objet Stripe, ou `null` si illisible
 * @param {'AT_PERIOD_END'|'NOW'} kind
 */
export function describeCancellationState(subscription, kind) {
  if (!subscription || typeof subscription !== 'object' || !subscription.id) {
    return CANCELLATION_STATE.INDETERMINATE;
  }

  /**
   * UN ABONNEMENT DÉJÀ CLOS SATISFAIT LES DEUX VERBES.
   *
   * Demander « résilie à l'échéance » sur un abonnement déjà terminé n'a plus
   * d'objet : l'engagement est fini, ce que la demande visait est acquis. Le
   * refuser obligerait l'appelant à distinguer deux formes de « c'est déjà
   * fait », pour aucun gain.
   */
  if (subscription.status === 'canceled') return CANCELLATION_STATE.ALREADY_DONE;

  if (kind === 'NOW') {
    /**
     * Tout statut autre que `canceled` signifie que la coupure n'a pas eu lieu.
     * `incomplete_expired` compris : l'abonnement n'a jamais démarré, mais
     * Stripe ne le déclare pas `canceled`, et prétendre le contraire ferait
     * conclure à tort qu'on a agi.
     */
    return CANCELLATION_STATE.NOT_DONE;
  }

  return subscription.cancel_at_period_end === true
    ? CANCELLATION_STATE.ALREADY_DONE
    : CANCELLATION_STATE.NOT_DONE;
}

/**
 * Ce que le projet reçoit — un CONSTAT, jamais l'objet Stripe.
 *
 * Les mêmes champs que la lecture d'abonnement de L6.2F : le projet projette
 * déjà cet état, et lui rendre une seconde forme l'obligerait à écrire deux
 * traductions pour une même réalité.
 */
export function describeCancelledSubscription(subscription, { alreadyDone }) {
  const idOf = (v) => (typeof v === 'string' ? v : v?.id ?? null);
  return {
    subscriptionId: String(subscription.id),
    status: subscription.status ?? null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    currentPeriodStart: Number.isFinite(subscription.current_period_start)
      ? subscription.current_period_start : null,
    currentPeriodEnd: Number.isFinite(subscription.current_period_end)
      ? subscription.current_period_end : null,
    latestInvoiceId: idOf(subscription.latest_invoice),
    customerId: idOf(subscription.customer),
    /**
     * `ALREADY_CANCELLED` n'est PAS un échec : c'est la preuve que la reprise a
     * constaté l'acte au lieu de le refaire. Le projet doit le traiter comme un
     * succès — sans quoi il rejouerait, et c'est exactement ce qu'on empêche.
     */
    outcome: alreadyDone ? 'ALREADY_CANCELLED' : 'CANCELLED',
  };
}

/** Trace d'une convergence par l'état — celle qu'un opérateur viendra lire. */
export function logConvergence({ subscriptionId, environment, kind, projectId }) {
  logger.info(
    `[stripe-cancel] convergence par l'état — ${kind} sur ${maskResourceId(subscriptionId)} `
    + `(${projectId}, ${environment}) : l'acte était déjà inscrit, aucune mutation émise.`,
  );
}

export default {
  CANCELLATION_STATE,
  cancellationOperationId,
  describeCancellationState,
  describeCancelledSubscription,
  logConvergence,
};
