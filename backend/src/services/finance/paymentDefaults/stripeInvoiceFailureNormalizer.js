import { subscriptionIdOfInvoice } from '../providerRevenue/stripeRevenueNormalizer.js';

/**
 * NORMALISATION D'UN ÉCHEC DE PRÉLÈVEMENT — fonction PURE (L10.6).
 *
 * ══ CE QU'ELLE EXTRAIT, ET POURQUOI CHAQUE CHAMP ═══════════════════════════
 *
 * Elle ne rend que ce dont l'incident a besoin, et surtout DEUX champs qui
 * n'existent que chez Stripe :
 *
 *   `next_payment_attempt`  quand STRIPE retentera. Recopié pour être AFFICHÉ,
 *                           jamais pour déclencher : le Panel ne retente rien.
 *   `attempt_count`         combien il a déjà essayé. Une donnée, pas un état.
 *
 * Sans eux, l'écran ne pourrait dire au client que « votre paiement a échoué »
 * — sans jamais dire quand sa carte sera représentée, qui est la seule chose
 * qu'il veut savoir.
 *
 * ══ CE QU'ELLE NE FAIT PAS ═════════════════════════════════════════════════
 *
 * Aucun calcul de date. `next_payment_attempt` est recopié tel quel : le
 * dériver d'un intervalle local produirait une date que Stripe ne respecterait
 * pas, affichée à un client qui la croirait.
 *
 * Aucune décision. Elle rend un fait ou rien.
 */

/** Le seul événement d'échec qui décrive une facture d'abonnement. */
export const INVOICE_FAILURE_EVENT = 'invoice.payment_failed';

/**
 * Événements qui ÉTEIGNENT un incident sans qu'il ait été payé.
 *
 * Une facture annulée ou déclarée irrécouvrable ne se paiera jamais : laisser
 * l'incident ouvert ferait fermer le site pour une dette que L.Y Solution a
 * elle-même effacée.
 */
export const INVOICE_CLOSING_EVENTS = Object.freeze([
  'invoice.voided',
  'invoice.marked_uncollectible',
  'customer.subscription.deleted',
]);

const idOf = (v) => {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object' && typeof v.id === 'string') return v.id;
  return null;
};
const chaine = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const entier = (v) => (Number.isInteger(v) ? v : null);
/** Un horodatage Stripe est en SECONDES. Converti ici, une fois. */
const instant = (s) => (Number.isFinite(s) ? new Date(s * 1000) : null);

/**
 * @returns {{fait: object|null, reason: string|null}}
 */
export function normalizeInvoiceFailure({ eventType, payload, environment } = {}) {
  if (String(eventType) !== INVOICE_FAILURE_EVENT) {
    return { fait: null, reason: 'NOT_A_FAILURE' };
  }
  const facture = payload?.data?.object ?? null;
  const invoiceId = idOf(facture);
  if (!invoiceId) return { fait: null, reason: 'MALFORMED' };

  /**
   * UNE FACTURE SANS RIEN À DEVOIR N'EST PAS UN IMPAYÉ.
   *
   * Stripe émet aussi cet événement sur des factures à zéro — essais gratuits,
   * avoirs couvrant la totalité. Ouvrir un incident ferait fermer un site pour
   * une dette de zéro euro.
   */
  const du = entier(facture.amount_due) ?? 0;
  const restant = entier(facture.amount_remaining);
  if (du <= 0 && (restant === null || restant <= 0)) {
    return { fait: null, reason: 'NOTHING_DUE' };
  }

  /**
   * SEUL UN ABONNEMENT ENTRE ICI.
   *
   * Une facture ponctuelle en échec — une prestation de L10.5, un frais de
   * lancement — ne relève PAS de ce cycle : elle ne suspend rien, et le CDC
   * l'exclut explicitement. Sans ce filtre, une prestation impayée fermerait le
   * site du client, ce que personne n'a demandé.
   */
  const subscriptionId = subscriptionIdOfInvoice(facture);
  if (!subscriptionId) return { fait: null, reason: 'NOT_A_SUBSCRIPTION' };

  const meta = facture.metadata && typeof facture.metadata === 'object' ? facture.metadata : {};

  return {
    fait: {
      environment,
      invoiceId,
      subscriptionId,
      paymentIntentId: idOf(facture.payment_intent),
      /** Corroboratif — l'appartenance se prouve par le lien, jamais ici. */
      claimedContractId: chaine(meta.contractId),

      amountDueCents: restant !== null && restant > 0 ? restant : du,
      currency: String(facture.currency ?? 'eur').toUpperCase(),
      invoiceNumber: chaine(facture.number),
      hostedInvoiceUrl: chaine(facture.hosted_invoice_url),
      invoicePdfUrl: chaine(facture.invoice_pdf),

      failedAt: instant(payload?.created) ?? new Date(),
      /** CE QUE STRIPE DÉCIDE — recopié, jamais calculé. */
      nextPaymentAttemptAt: instant(facture.next_payment_attempt),
      attemptCount: entier(facture.attempt_count) ?? 0,
      failureCode: chaine(facture.last_finalization_error?.code)
        ?? chaine(facture.last_payment_error?.code),

      declaredLivemode: typeof facture.livemode === 'boolean' ? facture.livemode : null,
    },
    reason: null,
  };
}

export default { INVOICE_FAILURE_EVENT, INVOICE_CLOSING_EVENTS, normalizeInvoiceFailure };
