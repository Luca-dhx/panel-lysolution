/**
 * L'AUTORITÉ DU REMBOURSEMENT — ce qu'on peut affirmer d'un remboursement
 * Stripe sans jamais l'appeler (L10.4).
 *
 * ══ POURQUOI CE MODULE NE RESSEMBLE PAS À `stripeSubscriptionCancellation` ══
 *
 * La résiliation (L6.2G) convergeait PAR L'ÉTAT : un abonnement est résilié ou
 * ne l'est pas, l'objet répond, et rejouer revient à relire. Le remboursement
 * n'offre pas ce confort, et c'est la difficulté centrale du lot.
 *
 * Un paiement de 500 € peut légitimement porter DEUX remboursements partiels de
 * 100 €, demandés à deux moments, pour deux raisons. Aucune lecture d'état ne
 * distingue « le second n'a pas encore eu lieu » de « le premier a eu lieu deux
 * fois ». Le montant déjà remboursé ne tranche rien : 200 € rendus peuvent être
 * un acte de 200 ou deux actes de 100.
 *
 * La convergence ne peut donc pas venir de l'état. Elle vient de l'IDENTITÉ DE
 * L'ACTE, et il faut la retrouver CHEZ STRIPE, pas seulement chez nous :
 *
 *   1. la clé d'idempotence protège la fenêtre courte du fournisseur ;
 *   2. au-delà, `metadata.ly_operation_id`, apposé sur le remboursement au
 *      moment de sa création, permet de RECONNAÎTRE notre propre acte dans la
 *      liste des remboursements du paiement — indéfiniment.
 *
 * Le point 2 est ce qui rend un rejeu sûr un an après. Sans lui, une reprise
 * hors fenêtre créerait un second remboursement bien réel.
 *
 * ══ LA MÉTADONNÉE DÉCIDE-T-ELLE ? ══════════════════════════════════════════
 *
 * Ici, oui — et c'est compatible avec la doctrine L6.2A qui dit l'inverse.
 * Cette doctrine interdit à la métadonnée de décider de L'APPARTENANCE, parce
 * qu'un tiers peut en écrire une. Elle ne dit rien de l'identité d'un acte
 * qu'on a soi-même émis, sur une ressource dont l'appartenance est DÉJÀ prouvée
 * par le registre de liens. On ne demande pas à la métadonnée « à qui est-ce »
 * mais « est-ce moi qui l'ai fait, sous ce nom ». La question précédente a déjà
 * été tranchée ailleurs, et sans elle on n'arrive jamais ici.
 *
 * Module PUR : aucune E/S, aucun import Stripe. Il lit des charges utiles.
 */

/** La clé de métadonnée qui porte l'identité de notre acte, chez Stripe. */
export const REFUND_OPERATION_METADATA_KEY = 'ly_operation_id';

/**
 * Ce que la lecture des remboursements existants permet d'affirmer.
 *
 * `ALREADY_DONE` n'est PAS « ce paiement a déjà été remboursé » — il l'est
 * peut-être, et un second remboursement resterait légitime. Il signifie « CET
 * acte-ci, sous CETTE identité, est déjà inscrit chez Stripe ».
 */
export const REFUND_ACT_STATE = Object.freeze({
  ALREADY_DONE: 'ALREADY_DONE',
  NOT_DONE: 'NOT_DONE',
  INDETERMINATE: 'INDETERMINATE',
});

/** Les statuts qu'un objet Refund Stripe peut porter. */
export const STRIPE_REFUND_STATUS = Object.freeze({
  PENDING: 'pending',
  REQUIRES_ACTION: 'requires_action',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
});

/**
 * Les seuls motifs que Stripe accepte. Tout autre texte est REFUSÉ par l'API —
 * la raison libre de l'opérateur vit donc chez nous, pas chez le fournisseur.
 */
export const STRIPE_REFUND_REASONS = Object.freeze([
  'duplicate',
  'fraudulent',
  'requested_by_customer',
]);

/**
 * Un remboursement compte-t-il dans ce qui a déjà été rendu ?
 *
 * `failed` et `canceled` ne rendent RIEN au client : les compter réduirait à
 * tort le remboursable restant et bloquerait un remboursement légitime. Stripe
 * ne les compte pas non plus dans `amount_refunded`.
 */
export function refundCounts(refund) {
  const status = String(refund?.status ?? '').trim();
  return status !== STRIPE_REFUND_STATUS.FAILED && status !== STRIPE_REFUND_STATUS.CANCELED;
}

/**
 * L'IDENTITÉ DURABLE DE L'ACTE.
 *
 * Contrairement à la résiliation, elle n'est PAS dérivée de la ressource :
 * `(environnement, abonnement)` suffisait là-bas parce qu'on ne résilie qu'une
 * fois. Dériver de `(environnement, paiement)` ici rendrait le second
 * remboursement partiel impossible à nommer — il porterait l'identité du
 * premier et serait éternellement vu comme « déjà fait ».
 *
 * L'identité vient donc de la DEMANDE : le Panel en ouvre une, durable, avant
 * tout contact fournisseur, et c'est son identifiant qu'on transporte ici. Deux
 * clics sur la même demande la rejouent ; deux demandes sont deux actes.
 */
export function refundOperationId({ environment, refundRequestId }) {
  const env = String(environment ?? '').trim().toUpperCase();
  const id = String(refundRequestId ?? '').trim();
  if (!env) throw new Error('refundOperationId : environnement manquant.');
  if (!id) throw new Error('refundOperationId : identifiant de demande manquant.');
  return `stripe-refund:${env.toLowerCase()}:${id}`;
}

/**
 * Retrouve NOTRE acte parmi les remboursements d'un paiement.
 *
 * @returns {{state: string, refund: object|null}}
 */
export function findOwnRefund({ refunds, operationId }) {
  if (!Array.isArray(refunds)) return { state: REFUND_ACT_STATE.INDETERMINATE, refund: null };
  const wanted = String(operationId ?? '').trim();
  if (!wanted) return { state: REFUND_ACT_STATE.INDETERMINATE, refund: null };

  for (const refund of refunds) {
    const stamped = refund?.metadata?.[REFUND_OPERATION_METADATA_KEY];
    if (stamped && String(stamped).trim() === wanted) {
      return { state: REFUND_ACT_STATE.ALREADY_DONE, refund };
    }
  }
  return { state: REFUND_ACT_STATE.NOT_DONE, refund: null };
}

/**
 * Combien ce paiement a-t-il déjà rendu, et combien peut-il encore rendre ?
 *
 * Le montant de référence est `amount_received`, non `amount` : le premier est
 * ce que le client a RÉELLEMENT payé, le second ce qui avait été demandé. Une
 * intention partiellement capturée ou abandonnée ne se rembourse qu'à hauteur
 * de ce qui est entré.
 *
 * @returns {{collectedCents:number, refundedCents:number, remainingCents:number}|null}
 *          `null` quand la charge utile ne permet aucune affirmation.
 */
export function describeRefundableAmount({ paymentIntent, refunds }) {
  const collected = paymentIntent?.amount_received;
  if (!Number.isInteger(collected) || collected < 0) return null;
  if (!Array.isArray(refunds)) return null;

  let refunded = 0;
  for (const refund of refunds) {
    if (!refundCounts(refund)) continue;
    const amount = refund?.amount;
    /**
     * Un remboursement sans montant entier rend la somme FAUSSE, et une somme
     * fausse autorise un remboursement excédentaire. On refuse d'affirmer.
     */
    if (!Number.isInteger(amount) || amount < 0) return null;
    refunded += amount;
  }

  return {
    collectedCents: collected,
    refundedCents: refunded,
    remainingCents: Math.max(0, collected - refunded),
  };
}

/**
 * La charge d'un paiement, quelle que soit la version d'API qui l'a rendue.
 *
 * `charges.data[0]` a disparu des versions récentes au profit de
 * `latest_charge`, qui est un identifiant nu ou un objet selon l'expansion
 * demandée. Les trois formes coexistent dans les charges utiles qu'on reçoit —
 * réponse d'appel, événement de webhook, rejeu d'archive.
 */
export function chargeOfPaymentIntent(paymentIntent) {
  const latest = paymentIntent?.latest_charge;
  if (typeof latest === 'string' && latest) return { id: latest, charge: null };
  if (latest && typeof latest === 'object' && latest.id) return { id: latest.id, charge: latest };

  const legacy = paymentIntent?.charges?.data?.[0];
  if (legacy?.id) return { id: legacy.id, charge: legacy };
  return { id: null, charge: null };
}

/**
 * Le reçu Stripe d'un paiement — le SEUL document que le fournisseur tienne à
 * jour après un remboursement (voir l'audit documentaire du rapport L10.4).
 *
 * Il vit sur la charge, pas sur le remboursement : un objet Refund n'a ni PDF
 * ni page hébergée. Le reçu, lui, est réédité par Stripe et affiche les sommes
 * rendues. C'est pour cette raison qu'on le conserve, et pour cette raison
 * seulement — ce n'est ni une facture, ni un avoir.
 */
export function receiptUrlOfCharge(charge) {
  const url = charge?.receipt_url;
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

/**
 * Traduit un objet Refund Stripe en un fait exploitable par le Panel.
 *
 * @returns {object|null} `null` si la charge utile n'est pas un remboursement.
 */
export function describeRefund(refund, { receiptUrl = null } = {}) {
  const id = refund?.id;
  if (typeof id !== 'string' || !id.startsWith('re_')) return null;

  const amount = Number.isInteger(refund.amount) ? refund.amount : null;
  if (amount === null) return null;

  /** Stripe rend ces champs nus ou étendus selon l'appel. Les deux formes. */
  const idOf = (value) => (typeof value === 'string' ? value : value?.id ?? null);
  const chargeId = idOf(refund.charge);
  const paymentIntentId = idOf(refund.payment_intent);

  return {
    refundId: id,
    status: typeof refund.status === 'string' ? refund.status : null,
    amountCents: amount,
    currency: String(refund.currency ?? 'eur').toUpperCase(),
    paymentIntentId,
    chargeId,
    reason: typeof refund.reason === 'string' ? refund.reason : null,
    createdAt: Number.isInteger(refund.created) ? refund.created : null,
    receiptUrl,
    operationId: refund?.metadata?.[REFUND_OPERATION_METADATA_KEY]
      ? String(refund.metadata[REFUND_OPERATION_METADATA_KEY])
      : null,
  };
}

/**
 * Un remboursement `pending` est-il un échec ? NON — et cette fonction existe
 * pour que personne n'ait à trancher au cas par cas.
 *
 * Sur carte, Stripe rend `succeeded` presque toujours immédiatement. Sur
 * prélèvement, virement ou certains moyens locaux, l'objet reste `pending`
 * plusieurs jours. Le traiter comme un échec ferait proposer un SECOND
 * remboursement pour un premier parfaitement en cours.
 */
export function isRefundSettled(refund) {
  return String(refund?.status ?? '') === STRIPE_REFUND_STATUS.SUCCEEDED;
}

export function isRefundFailed(refund) {
  const status = String(refund?.status ?? '');
  return status === STRIPE_REFUND_STATUS.FAILED || status === STRIPE_REFUND_STATUS.CANCELED;
}

export default {
  REFUND_OPERATION_METADATA_KEY,
  REFUND_ACT_STATE,
  STRIPE_REFUND_STATUS,
  STRIPE_REFUND_REASONS,
  refundCounts,
  refundOperationId,
  findOwnRefund,
  describeRefundableAmount,
  chargeOfPaymentIntent,
  receiptUrlOfCharge,
  describeRefund,
  isRefundSettled,
  isRefundFailed,
};
