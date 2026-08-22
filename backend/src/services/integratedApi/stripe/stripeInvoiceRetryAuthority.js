// RETENTER LA COLLECTE D'UNE FACTURE IMPAYÉE — l'autorité de l'acte.
//
// ══ CE QUE CE FICHIER DÉCIDE, ET CE QU'IL NE DÉCIDE PAS ═════════════════════
//
// Il décide QUAND une nouvelle tentative est légitime, et sous QUELLE identité
// d'acte elle part. Il ne décide ni du montant, ni du moyen de paiement, ni du
// moment des tentatives AUTOMATIQUES — celles-là appartiennent à Stripe, et
// rien ici ne les programme.
//
// ══ POURQUOI UNE TENTATIVE MANUELLE NE CONTREDIT PAS LA DOCTRINE ════════════
//
// « Stripe est l'unique ordonnanceur des tentatives » interdit de PROGRAMMER
// une boucle : deux calendriers sur la même facture produisent le double débit.
// Elle n'interdit pas d'en déclencher UNE, à la main, quand un exploitant sait
// quelque chose que Stripe ignore — typiquement : le client vient d'appeler
// pour dire que sa carte est réapprovisionnée, et personne n'a envie
// d'attendre la prochaine tentative programmée dans quatre jours.
//
// La différence est celle entre un réveil et un coup d'œil à sa montre.
//
// ══ L'IDENTITÉ D'ACTE PORTE LE NOMBRE DE TENTATIVES ═════════════════════════
//
//     stripe-invoice-retry:<monde>:<facture>:<tentatives déjà faites>
//
// C'est ce qui donne les deux propriétés qu'on veut EN MÊME TEMPS :
//
//   · deux clics sur le même état    → même acte    → UNE seule tentative ;
//   · un nouvel essai après un échec → autre acte   → tentative autorisée.
//
// Une clé fixe par facture aurait interdit tout second essai de la journée ;
// une clé aléatoire aurait rendu le double clic coûteux. Le compteur de Stripe
// est le seul discriminant qui suive exactement l'état réel de la créance.
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
} from '../../capabilities/capabilityErrors.js';

/* -------------------------------------------------------------------------- */
/*  REFUS                                                                     */
/* -------------------------------------------------------------------------- */

export const RETRY_REFUSALS = Object.freeze({
  /** La facture est déjà réglée. Retenter serait un second débit. */
  PAYMENT_ALREADY_PAID: 'PAYMENT_ALREADY_PAID',
  /**
   * L'état de la facture interdit une tentative : brouillon, annulée, passée
   * en irrécouvrable, ou soldée à zéro. Aucun de ces cas n'est une anomalie —
   * ce sont des situations où il n'y a simplement rien à collecter.
   */
  PAYMENT_NOT_RETRYABLE: 'PAYMENT_NOT_RETRYABLE',
});

/* -------------------------------------------------------------------------- */
/*  L'IDENTITÉ DE L'ACTE                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Forme LISIBLE, et non hachée : c'est ce qu'un exploitant lira dans le
 * registre d'opérations le jour où il cherchera pourquoi une tentative n'est
 * pas partie. La clé d'idempotence qui voyage chez Stripe en est dérivée.
 *
 * Le `projectId` en fait partie : le registre d'opérations le porte déjà, mais
 * la lecture du compteur exige de relire la facture, et cette lecture-là est
 * faite AVEC les identifiants du projet. Deux projets ne peuvent de toute
 * façon pas posséder la même facture.
 *
 * @param {{environment: string, projectId: string, invoiceId: string,
 *   attemptCount?: number|null}} args
 */
export function retryOperationId({ environment, projectId, invoiceId, attemptCount = null }) {
  const tentatives = Number.isFinite(attemptCount) ? attemptCount : 'n';
  return `stripe-invoice-retry:${environment}:${projectId}:${invoiceId}:${tentatives}`;
}

/* -------------------------------------------------------------------------- */
/*  LA DÉCISION                                                               */
/* -------------------------------------------------------------------------- */

/**
 * CETTE FACTURE PEUT-ELLE ÊTRE RETENTÉE, DANS L'ÉTAT OÙ ELLE EST ?
 *
 * ══ POURQUOI ON RELIT LA FACTURE PLUTÔT QUE DE CROIRE L'INCIDENT ═══════════
 *
 * L'incident du Panel est un OBSERVATOIRE : il reflète ce que le dernier
 * webhook a dit. Entre-temps, Stripe a pu retenter et réussir. Déclencher une
 * tentative sur la foi d'un incident périmé produirait exactement le double
 * débit que toute cette doctrine évite.
 *
 * La source de vérité est donc la facture RELUE, à l'instant du clic.
 *
 * @param {object} facture  l'objet Stripe, relu
 * @returns {{attemptCount: number|null}}
 * @throws {CapabilityError} refus NOMMÉ — jamais un 500
 */
export function assertInvoiceRetryable(facture) {
  const statut = String(facture?.status ?? '');
  const restant = Number(facture?.amount_remaining ?? 0);

  if (facture?.paid === true || statut === 'paid') {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      'Cette facture est déjà réglée : aucune nouvelle tentative n’est possible.',
      { reason: RETRY_REFUSALS.PAYMENT_ALREADY_PAID, status: statut },
    );
  }

  /**
   * SEUL `open` SE RETENTE.
   *
   * `draft` n'a pas été émise, `void` a été annulée, `uncollectible` a été
   * abandonnée comptablement. Retenter l'une des trois n'aurait pas de sens
   * métier — et Stripe refuserait de toute façon, mais après un aller-retour
   * et avec un message qui ne parle qu'à un développeur.
   */
  if (statut !== 'open') {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      `L’état de cette facture (« ${statut || 'inconnu'} ») ne permet pas de retenter le paiement.`,
      { reason: RETRY_REFUSALS.PAYMENT_NOT_RETRYABLE, status: statut },
    );
  }

  if (!(restant > 0)) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      'Cette facture ne présente plus aucun montant dû.',
      { reason: RETRY_REFUSALS.PAYMENT_NOT_RETRYABLE, amountRemaining: restant },
    );
  }

  return { attemptCount: Number.isFinite(facture?.attempt_count) ? facture.attempt_count : null };
}

/** Ce que l'exploitant lit après la tentative — l'état RELU, jamais déduit. */
export function vueTentative(facture) {
  return {
    invoiceId: String(facture?.id ?? ''),
    status: facture?.status ?? null,
    paid: facture?.paid === true,
    attemptCount: Number.isFinite(facture?.attempt_count) ? facture.attempt_count : null,
    amountRemaining: Number.isFinite(facture?.amount_remaining) ? facture.amount_remaining : null,
    nextPaymentAttemptAt: Number.isFinite(facture?.next_payment_attempt)
      ? facture.next_payment_attempt
      : null,
    hostedInvoiceUrl: facture?.hosted_invoice_url ?? null,
  };
}

export default { RETRY_REFUSALS, retryOperationId, assertInvoiceRetryable, vueTentative };
