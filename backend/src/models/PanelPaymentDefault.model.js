import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

/**
 * DÉFAUT DE PAIEMENT D'ABONNEMENT — l'incident, pas la tentative (L10.6).
 *
 * ══ LA DOCTRINE QUI TIENT TOUT LE LOT ═══════════════════════════════════════
 *
 * **STRIPE EST L'UNIQUE ORDONNANCEUR DES TENTATIVES DE COLLECTE.**
 *
 * Le Panel n'en déclenche aucune, n'en programme aucune, et n'en configure
 * aucune. Sur un abonnement en recouvrement automatique, Stripe retente selon
 * les réglages de relance du compte et publie lui-même la date de sa prochaine
 * tentative. Écrire notre propre boucle reviendrait à appeler
 * `POST /v1/invoices/{id}/pay` en course avec celle que Stripe a déjà
 * programmée — c'est-à-dire à créer le double débit.
 *
 * Ce modèle est donc un OBSERVATOIRE. Tout ce qu'il porte du fournisseur est
 * RECOPIÉ, jamais calculé :
 *
 *   `nextPaymentAttemptAt`  vient de `invoice.next_payment_attempt`
 *   `attemptCount`          vient de `invoice.attempt_count`
 *
 * Il n'existe volontairement AUCUN champ `retryInterval`. Une configuration
 * locale d'intervalle laisserait croire qu'on pilote la collecte, alors qu'on
 * la regarde. C'est exactement ce que `contractPaymentGraceDays` est devenu
 * côté projet : un réglage que personne ne lit et que tout le monde croit actif.
 *
 * ══ CE SUR QUOI LE PANEL EST BIEN AUTORITÉ ══════════════════════════════════
 *
 * Le DÉLAI DE GRÂCE, et lui seul. C'est une politique commerciale : combien de
 * temps L.Y Solution laisse un client en défaut avant de couper. Stripe n'en
 * sait rien et n'a pas à en savoir quelque chose.
 *
 * Le Panel ne suspend pas non plus : à l'échéance, il CONSTATE le défaut et le
 * signale. C'est SB Auto qui recalcule l'accessibilité de son site, parce que
 * lui seul connaît les autres causes en vigueur.
 */

/**
 * LES QUATRE ÉTATS, ET PAS UN DE PLUS.
 *
 *     OPEN ──────────► GRACE_EXPIRED ──────────► RESOLVED
 *       │                    │                       ▲
 *       └────────────────────┴───────────────────────┘
 *                        (paiement établi)
 *
 * ══ POURQUOI PAS D'ÉTAT `RETRYING` ══════════════════════════════════════════
 *
 * Parce que nous ne retentons rien. Un état qui décrirait « une tentative est
 * en cours » décrirait une action de Stripe que nous n'observons qu'après coup,
 * et il serait faux la plupart du temps. Le nombre de tentatives est une
 * DONNÉE (`attemptCount`), pas un état.
 *
 * ══ POURQUOI PAS D'ÉTAT `SUSPENDED` ═════════════════════════════════════════
 *
 * Parce que la suspension n'appartient pas à cet incident. Le Panel constate
 * que la grâce a expiré ; c'est SB Auto qui décide si le site ferme, et il peut
 * parfaitement rester ouvert — par exemple si la protection contractuelle est
 * désactivée. Inscrire `SUSPENDED` ici affirmerait un fait dont on n'a pas
 * l'autorité, et qui pourrait être faux.
 *
 * `suspensionRequestedAt` porte donc la DEMANDE, jamais le résultat.
 *
 * `RESOLVED` est TERMINAL. Un impayé ultérieur sur une autre période est un
 * NOUVEL incident — jamais la résurrection de celui-ci.
 */
export const PAYMENT_DEFAULT_STATUS = Object.freeze({
  /** L'argent n'est pas rentré. La grâce court. */
  OPEN: 'OPEN',
  /** La grâce est écoulée et rien n'est payé. Le site peut fermer. */
  GRACE_EXPIRED: 'GRACE_EXPIRED',
  /** Le paiement est établi par Stripe. TERMINAL. */
  RESOLVED: 'RESOLVED',
  /**
   * L'incident cesse sans paiement : abonnement résilié, facture annulée ou
   * passée en irrécouvrable. TERMINAL — et distinct de `RESOLVED`, parce que
   * personne n'a payé et que les totaux ne doivent pas le laisser croire.
   */
  CLOSED: 'CLOSED',
});

export const PAYMENT_DEFAULT_STATUS_VALUES = Object.freeze(
  Object.values(PAYMENT_DEFAULT_STATUS),
);

export const TERMINAL_STATUSES = Object.freeze([
  PAYMENT_DEFAULT_STATUS.RESOLVED,
  PAYMENT_DEFAULT_STATUS.CLOSED,
]);

/** Un incident encore vivant ? La seule question que l'ordonnanceur pose. */
export function isLive(status) {
  return !TERMINAL_STATUSES.includes(String(status));
}

/**
 * Cet incident doit-il fermer le site ?
 *
 * `GRACE_EXPIRED` et lui seul. Un incident `OPEN` ne suspend jamais : c'est
 * tout l'objet du délai de grâce.
 */
export function demandsSuspension(status) {
  return String(status) === PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED;
}

const paymentDefaultSchema = new mongoose.Schema(
  {
    paymentDefaultId: { type: String, required: true, unique: true },

    projectId: { type: String, required: true },
    /** Le contrat concerné, tel que la projection le nomme. Peut manquer. */
    contractId: { type: String, default: null },

    /**
     * LE MONDE, ET IL FAIT PARTIE DE L'IDENTITÉ.
     *
     * Un échec de recette ne doit jamais fermer un site de production. Les
     * identifiants Stripe des deux mondes peuvent coïncider — ce sont deux
     * comptes distincts — et sans l'environnement dans la clé, un incident TEST
     * résoudrait son homonyme PROD.
     */
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    /**
     * ══ L'IDENTITÉ DE L'INCIDENT : LA FACTURE ═══════════════════════════════
     *
     * Une facture d'abonnement produit PLUSIEURS `invoice.payment_failed` —
     * Stripe retente, et chaque échec en émet un. Ils décrivent le MÊME
     * incident, et créer un défaut par événement ferait croire à quatre impayés
     * là où il n'y en a qu'un.
     *
     * Deux périodes d'abonnement, en revanche, sont deux factures, donc deux
     * incidents. C'est exactement la granularité voulue, et elle vient de
     * Stripe plutôt que d'un choix de notre part.
     *
     * `subscriptionId` est conservé pour l'audit, jamais pour identifier :
     * l'identité d'un abonnement traverserait toutes ses périodes.
     */
    invoiceId: { type: String, required: true },
    subscriptionId: { type: String, default: null },
    /** Renseigné quand Stripe l'expose — utile au rapprochement, pas à l'identité. */
    paymentIntentId: { type: String, default: null },

    // ── CE QUI EST DÛ ─────────────────────────────────────────────────────
    /** Ce que la facture réclame, en centimes entiers (doctrine L10.1). */
    amountDueCents: { type: Number, default: 0 },
    currency: { type: String, default: 'EUR' },
    invoiceNumber: { type: String, default: null },
    /** Les adresses Stripe — le client a le droit de sa facture. */
    hostedInvoiceUrl: { type: String, default: null },
    invoicePdfUrl: { type: String, default: null },

    // ── CE QUE STRIPE FAIT, ET QU'ON REGARDE ──────────────────────────────
    /**
     * LA PROCHAINE TENTATIVE DE STRIPE — recopiée de `next_payment_attempt`.
     *
     * Elle n'est JAMAIS calculée par nous, et rien ne s'en sert comme d'un
     * déclencheur : c'est un affichage, pour que le client sache quand sa carte
     * sera représentée. `null` signifie que Stripe a cessé de retenter.
     */
    nextPaymentAttemptAt: { type: Date, default: null },
    /** `invoice.attempt_count` — combien Stripe a déjà essayé. Recopié. */
    attemptCount: { type: Number, default: 0 },
    /** Le code d'échec du fournisseur, épuré. Diagnostic, jamais affiché brut. */
    lastFailureCode: { type: String, default: null },

    // ── CE DONT LE PANEL EST AUTORITÉ ─────────────────────────────────────
    /**
     * LE SNAPSHOT DE POLITIQUE — figé à l'ouverture de l'incident.
     *
     * ══ POURQUOI FIGÉ ════════════════════════════════════════════════════
     *
     * Un administrateur qui ramène la grâce de 7 à 3 jours ne doit pas fermer
     * rétroactivement un site dont l'échéance était annoncée au client pour
     * dans quatre jours. Une politique gouverne les incidents À VENIR ; changer
     * celle d'un incident en cours est un geste administratif distinct, qui
     * n'existe pas dans ce lot.
     *
     * C'est la même doctrine que le snapshot fiscal de L10.5 : ce qui a été
     * annoncé au client l'a été sous les règles du jour.
     */
    graceDaysSnapshot: { type: Number, default: null, min: 0 },
    /**
     * L'ÉCHÉANCE — calculée UNE FOIS, depuis le premier échec.
     *
     * Ancrée sur `firstFailedAt`, jamais sur le dernier échec : sinon chaque
     * tentative de Stripe repousserait la date, et la grâce n'expirerait
     * jamais. C'est le piège le plus naturel de tout le lot.
     *
     * `null` quand le contrat ne porte AUCUNE politique de grâce (L10.6B-1).
     * L'incident vit alors normalement — il est ouvert, suivi, affiché — mais
     * il n'expire jamais tout seul, parce que personne n'a fixé la date à
     * laquelle on fermerait le site. La fermeture reste humaine.
     */
    graceDeadlineAt: { type: Date, default: null },

    status: {
      type: String,
      enum: PAYMENT_DEFAULT_STATUS_VALUES,
      required: true,
      default: PAYMENT_DEFAULT_STATUS.OPEN,
    },

    firstFailedAt: { type: Date, required: true },
    lastFailedAt: { type: Date, default: null },
    /**
     * QUAND LA FERMETURE A ÉTÉ DEMANDÉE — pas quand elle a été appliquée.
     *
     * Le Panel n'a aucune autorité sur l'accessibilité du site. Il constate que
     * la grâce a expiré et le signale ; SB Auto tranche, et peut parfaitement
     * laisser le site ouvert. Écrire ici « suspendu » affirmerait un fait qu'on
     * n'a pas constaté.
     */
    suspensionRequestedAt: { type: Date, default: null },
    /**
     * LA CONFIRMATION, ET ELLE N'EST PAS LA DEMANDE (L10.6A).
     *
     * `suspensionRequestedAt` dit « le Panel a demandé la fermeture ».
     * `suspensionConfirmedAt` dit « le projet l'a réellement appliquée, et son
     * site est inaccessible ». Les confondre ferait annoncer une fermeture qui
     * n'a peut-être jamais eu lieu — projet éteint, cause non livrée, protection
     * contractuelle désactivée.
     *
     * La preuve vient du snapshot autoritatif renvoyé par le projet, jamais
     * d'une déduction locale. Voir `confirmFromSiteStatus`.
     */
    suspensionConfirmedAt: { type: Date, default: null },
    /**
     * LA CAUSE A ÉTÉ RETIRÉE — ce qui n'est PAS « le site est réactivé ».
     *
     * Une maintenance technique peut parfaitement subsister. Cette date atteste
     * du retrait de NOTRE cause, et de rien d'autre.
     */
    causeRemovalConfirmedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    /** Comment l'incident s'est terminé. Nommé, jamais déduit d'un statut. */
    resolution: { type: String, default: null },

    /**
     * LE REVENU PRODUIT PAR LA RÉGULARISATION — s'il y en a un.
     *
     * Descendant, comme pour une prestation (L10.5) : l'incident APPREND
     * l'identité du mouvement, il ne l'écrit pas. Un défaut de paiement n'est
     * ni un coût ni un revenu — c'est l'ABSENCE d'un revenu, et une absence ne
     * s'inscrit pas au livret.
     */
    transactionId: { type: String, default: null },

    /**
     * L'HISTORIQUE — chaque transition, avec sa cause. Borné à trente.
     * Au-delà, c'est une boucle et non un besoin.
     */
    history: {
      type: [{
        at: { type: String, required: true },
        from: { type: String, default: null },
        to: { type: String, required: true },
        reason: { type: String, default: null },
        _id: false,
      }],
      default: [],
    },
  },
  { minimize: false, versionKey: false, timestamps: true },
);

/**
 * L'IDENTITÉ CANONIQUE — une facture, un incident, dans un monde donné.
 *
 * C'est cet index, et non un `findOne` préalable, qui garantit qu'un webhook
 * rejoué quatre fois ne produit qu'un défaut. Deux livraisons concurrentes le
 * trouveraient toutes deux absent ; l'index, lui, tranche.
 */
paymentDefaultSchema.index(
  { environment: 1, invoiceId: 1 },
  { unique: true, name: 'uniq_invoice_default' },
);

/**
 * LA FILE DE L'ORDONNANCEUR — « quelle grâce a expiré ? ».
 *
 * Sur le chemin critique : sans elle, chaque tour balaierait tous les incidents
 * du parc pour n'en trouver aucun.
 */
paymentDefaultSchema.index(
  { status: 1, graceDeadlineAt: 1 },
  { name: 'grace_queue' },
);

/** L'écran du projet : « ce client a-t-il un impayé ? ». */
paymentDefaultSchema.index({ projectId: 1, status: 1 }, { name: 'project_status' });

export const PanelPaymentDefault = mongoose.model('PanelPaymentDefault', paymentDefaultSchema);

export default PanelPaymentDefault;
