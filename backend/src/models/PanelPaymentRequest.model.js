import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

/**
 * LA DEMANDE DE PAIEMENT — de l'argent RÉCLAMÉ (L10.5).
 *
 * ══ POURQUOI CE N'EST PAS UNE TRANSACTION FINANCIÈRE ════════════════════════
 *
 * `PanelFinancialTransaction` est le LEDGER : il enregistre ce qui a EU LIEU.
 * Une prestation de 500 € qu'on facture n'a rien eu lieu du tout — personne n'a
 * encaissé, et peut-être personne n'encaissera. L'y écrire ferait apparaître
 * 500 € de chiffre d'affaires le jour de l'envoi du devis, et le bénéfice du
 * mois dépendrait de ce qu'on espère plutôt que de ce qu'on a.
 *
 * Les deux objets se rejoignent à un seul instant : le paiement. La demande
 * passe `PAID`, et le revenu naît — mais pas d'ici. Il naît de la projection
 * L10.3, à partir du fait fournisseur, comme tout autre encaissement Stripe.
 * Voir `paymentRequests.service.js`, § « la demande ne crée aucun revenu ».
 *
 * ══ POURQUOI PAS `Payment` DE SB AUTO ══════════════════════════════════════
 *
 * Trois raisons, et chacune suffirait :
 *
 *   • il vit dans le PROJET, alors que l'autorité du montant doit être au
 *     Panel — sinon le client décide de ce qu'il paie ;
 *   • il est rattaché à un `contractId` obligatoire, or une prestation
 *     ponctuelle n'est pas un contrat ;
 *   • son type est fermé sur `LAUNCH_FEE | SUBSCRIPTION`. L'élargir ferait
 *     entrer le vocabulaire des prestations dans un journal qui décrit
 *     l'exécution d'un contrat.
 *
 * ══ POURQUOI PAS `Invoice` DE SB AUTO ══════════════════════════════════════
 *
 * Il exige `externalInvoiceId` : c'est le MIROIR d'une facture Stripe réelle,
 * pas une abstraction métier. Une demande non payée n'a aucune facture.
 */

/**
 * LA MACHINE D'ÉTAT. Fermée, et volontairement courte.
 *
 *     DRAFT ──────► OPEN ──────► PAYMENT_PENDING ──────► PAID
 *                    │                  │
 *                    │                  └──────► OPEN      (session abandonnée)
 *                    │
 *                    ├──────► CANCELED
 *                    └──────► EXPIRED
 *
 * `PAID` est TERMINAL et ne redevient jamais `OPEN` : l'argent est arrivé, et
 * aucun état ultérieur ne peut le défaire. Un remboursement ne rouvre pas la
 * demande — il produit un mouvement inverse au ledger (L10.4), ce qui est une
 * tout autre affirmation.
 *
 * `FAILED` n'existe PAS comme état de la demande, et c'est délibéré. Une carte
 * refusée ne clôt rien : la demande reste due, donc `OPEN`, et le client
 * réessaie. Un état `FAILED` aurait obligé à inventer le chemin du retour vers
 * `OPEN`, c'est-à-dire à décrire deux fois la même chose.
 */
export const PAYMENT_REQUEST_STATUS = Object.freeze({
  /** Saisie non envoyée. Aucune ressource fournisseur, invisible du client. */
  DRAFT: 'DRAFT',
  /** Envoyée. Le client la voit et peut payer. C'est l'état « À payer ». */
  OPEN: 'OPEN',
  /**
   * Une session de paiement est ouverte chez Stripe. Le client est peut-être
   * en train de saisir sa carte — ou a fermé l'onglet il y a trois jours.
   */
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  /** L'argent est arrivé, prouvé par le fournisseur. TERMINAL. */
  PAID: 'PAID',
  /** Retirée par un opérateur. Plus payable, plus relancée. TERMINAL. */
  CANCELED: 'CANCELED',
  /** Échue sans paiement. TERMINAL. */
  EXPIRED: 'EXPIRED',
});

export const PAYMENT_REQUEST_STATUS_VALUES = Object.freeze(
  Object.values(PAYMENT_REQUEST_STATUS),
);

/** Les états TERMINAUX — rien n'en sort, jamais. */
export const TERMINAL_STATUSES = Object.freeze([
  PAYMENT_REQUEST_STATUS.PAID,
  PAYMENT_REQUEST_STATUS.CANCELED,
  PAYMENT_REQUEST_STATUS.EXPIRED,
]);

/**
 * LES TRANSITIONS PERMISES. Table FERMÉE, lue par le service.
 *
 * Une table plutôt que des `if` dispersés : c'est le seul endroit où l'on peut
 * répondre d'un coup d'œil à « une demande payée peut-elle être annulée ? ».
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [PAYMENT_REQUEST_STATUS.DRAFT]: Object.freeze([
    PAYMENT_REQUEST_STATUS.OPEN,
    PAYMENT_REQUEST_STATUS.CANCELED,
  ]),
  [PAYMENT_REQUEST_STATUS.OPEN]: Object.freeze([
    PAYMENT_REQUEST_STATUS.PAYMENT_PENDING,
    /**
     * OPEN → PAID DIRECTEMENT, et ce n'est pas un raccourci.
     *
     * Le webhook de paiement peut arriver avant que l'ouverture de session
     * n'ait fini d'être enregistrée chez nous — ou après un paiement fait
     * depuis un lien retrouvé dans un ancien e-mail. Exiger le passage par
     * `PAYMENT_PENDING` ferait refuser une preuve de paiement RÉELLE au motif
     * qu'on n'avait pas noté l'intention.
     */
    PAYMENT_REQUEST_STATUS.PAID,
    PAYMENT_REQUEST_STATUS.CANCELED,
    PAYMENT_REQUEST_STATUS.EXPIRED,
  ]),
  [PAYMENT_REQUEST_STATUS.PAYMENT_PENDING]: Object.freeze([
    PAYMENT_REQUEST_STATUS.PAID,
    /** Session abandonnée ou expirée : la somme reste due. */
    PAYMENT_REQUEST_STATUS.OPEN,
    PAYMENT_REQUEST_STATUS.CANCELED,
    PAYMENT_REQUEST_STATUS.EXPIRED,
  ]),
  [PAYMENT_REQUEST_STATUS.PAID]: Object.freeze([]),
  [PAYMENT_REQUEST_STATUS.CANCELED]: Object.freeze([]),
  [PAYMENT_REQUEST_STATUS.EXPIRED]: Object.freeze([]),
});

/** Cette transition est-elle permise ? Aucune exception nulle part ailleurs. */
export function canTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** La demande est-elle encore payable ? La seule question que l'écran pose. */
export function isPayable(status) {
  return status === PAYMENT_REQUEST_STATUS.OPEN
    || status === PAYMENT_REQUEST_STATUS.PAYMENT_PENDING;
}

/** Ce qui a produit la demande. Ouvert par nécessité future, pas par principe. */
export const PAYMENT_REQUEST_SOURCES = Object.freeze({
  /** Un opérateur l'a saisie depuis l'onglet Finances. Le seul cas de L10.5. */
  MANUAL: 'MANUAL',
});

const reminderSchema = new mongoose.Schema(
  {
    /**
     * LES RELANCES SONT UN RÉGLAGE, PAS UN MINUTEUR.
     *
     * Rien n'est armé en mémoire : `nextAt` est une DATE en base, et
     * l'ordonnanceur financier — celui qui matérialise déjà les coûts
     * récurrents et fait converger les revenus — la relit à chaque tour. Un
     * redémarrage ne perd donc aucune relance, et deux instances qui tournent
     * n'en envoient pas deux (voir la réservation atomique du service).
     */
    enabled: { type: Boolean, default: false },
    /** Jours entre deux relances. Entier, borné par le service. */
    intervalDays: { type: Number, default: 7 },
    /** Quand la prochaine partira. `null` = aucune n'est armée. */
    nextAt: { type: Date, default: null },
    lastSentAt: { type: Date, default: null },
    /** Combien sont parties. Une trace, pas un compteur d'arrêt. */
    count: { type: Number, default: 0 },
    /** Le dernier échec d'envoi. Un e-mail perdu ne perd pas la créance. */
    lastError: { type: String, default: null },
  },
  { _id: false },
);

const paymentRequestSchema = new mongoose.Schema(
  {
    paymentRequestId: { type: String, required: true, unique: true },

    /**
     * TOUJOURS un projet. Contrairement à un mouvement du ledger, une demande
     * de paiement sans destinataire n'a aucun sens : on ne se réclame pas de
     * l'argent à soi-même.
     */
    projectId: { type: String, required: true },
    projectNameSnapshot: { type: String, default: null },

    label: { type: String, required: true },
    description: { type: String, default: '' },

    /**
     * ══ LE SNAPSHOT FISCAL — FIGÉ À LA CRÉATION, JAMAIS RECALCULÉ ═════════
     *
     * Quatre champs, tous en CENTIMES ENTIERS (doctrine L10.1), plus le taux
     * qui les a produits.
     *
     * ── POURQUOI UN SNAPSHOT, ET NON UNE LECTURE DYNAMIQUE ────────────────
     *
     * Le taux appartient au CONTRAT, et un contrat évolue. Si l'on relisait le
     * taux à chaque affichage, une prestation de 500 € HT facturée 600 € TTC
     * en août se mettrait à afficher 550 € le jour où le contrat passerait à
     * 10 % — pour une facture Stripe déjà émise à 600, et un revenu déjà
     * inscrit à 600. Le Panel raconterait alors une histoire que ni la banque
     * ni le client ne reconnaîtraient.
     *
     * Une facture est un ACTE DATÉ. Ce qui a été facturé l'a été au taux du
     * jour, et rien d'ultérieur ne le change.
     *
     * ── POURQUOI PAS UN SEUL MONTANT ──────────────────────────────────────
     *
     * Parce que trois lecteurs différents en attendent trois choses : Stripe
     * doit débiter le TTC, l'écran doit montrer la ventilation, et le client
     * doit retrouver ses 500 € HT sur sa facture. Un champ unique aurait
     * obligé chacun à recalculer les deux autres — donc à connaître le taux,
     * donc à le relire.
     */

    /** Ce que l'opérateur saisit : le prix hors taxe de la prestation. */
    netAmountCents: { type: Number, required: true, min: 1 },
    /**
     * LE TAUX APPLIQUÉ, EN POURCENTAGE — celui du contrat AU MOMENT DE LA
     * CRÉATION, projeté depuis le projet. Jamais une valeur par défaut : une
     * prestation ne se crée pas si le taux est inconnu.
     */
    taxRate: { type: Number, required: true, min: 0, max: 100 },
    taxAmountCents: { type: Number, required: true, min: 0 },
    /**
     * CE QUE STRIPE DÉBITE, ET CE QUE LE LEDGER CONSTATERA.
     *
     * C'est le montant AUTORITAIRE de tout le lot : le projet ne le transmet
     * jamais, il est lu ici au moment d'ouvrir la session de paiement.
     */
    grossAmountCents: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },

    status: {
      type: String,
      enum: PAYMENT_REQUEST_STATUS_VALUES,
      required: true,
      default: PAYMENT_REQUEST_STATUS.DRAFT,
    },

    source: {
      type: String,
      enum: Object.values(PAYMENT_REQUEST_SOURCES),
      default: PAYMENT_REQUEST_SOURCES.MANUAL,
    },

    /**
     * LE MONDE, CONSTATÉ À L'ENVOI — jamais choisi par un écran.
     *
     * Il fige celui de l'instance au moment où la demande devient payable, et
     * il fait partie de son identité : une demande de recette ne doit pas
     * pouvoir être payée en production, ni l'inverse.
     */
    environment: { type: String, enum: [...ENVIRONMENTS], default: null },

    /**
     * CE QUE STRIPE A PRODUIT — conservé pour l'audit et la convergence.
     *
     * Aucun de ces champs n'est une AUTORITÉ : le montant fait foi ici, et
     * l'appartenance se prouve par le registre de liens (L6.2A).
     */
    stripe: {
      checkoutSessionId: { type: String, default: null },
      /** L'URL hébergée par Stripe. Périssable — jamais servie de mémoire. */
      checkoutUrl: { type: String, default: null },
      paymentIntentId: { type: String, default: null },
      /** La facture RÉELLE que Stripe émet après paiement (invoice_creation). */
      invoiceId: { type: String, default: null },
      hostedInvoiceUrl: { type: String, default: null },
      invoicePdfUrl: { type: String, default: null },
    },

    /**
     * L'IDENTITÉ DE L'ACTE D'OUVERTURE, écrite AVANT tout appel fournisseur.
     *
     * Stable pour toute la vie de la demande : huit clics sur « Payer »
     * rendent la MÊME session, parce qu'ils portent la même clé d'idempotence.
     * Une nouvelle tentative après expiration de session en dérive une autre —
     * voir `checkoutAttempt`.
     */
    checkoutAttempt: { type: Number, default: 0 },

    /**
     * LE REVENU PRODUIT — le SEUL pont vers le ledger, et il est descendant.
     *
     * La demande ne crée pas la transaction : elle apprend son identité quand
     * la projection L10.3 l'a écrite. L'inverse — la demande écrivant le
     * revenu — produirait un second exemplaire dès l'arrivée du webhook.
     */
    transactionId: { type: String, default: null },

    reminders: { type: reminderSchema, default: () => ({}) },

    /**
     * L'HISTORIQUE MINIMAL — chaque changement d'état, avec sa cause.
     *
     * Borné à trente entrées : c'est une trace de diagnostic, et une demande
     * qui en accumulerait davantage révélerait une boucle, pas un besoin.
     */
    history: {
      type: [{
        at: { type: String, required: true },
        from: { type: String, default: null },
        to: { type: String, required: true },
        reason: { type: String, default: null },
        actor: { type: String, default: null },
        _id: false,
      }],
      default: [],
    },

    createdBy: { type: String, default: null },
    sentAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    canceledAt: { type: Date, default: null },
    canceledBy: { type: String, default: null },
    cancelReason: { type: String, default: null },
    expiresAt: { type: Date, default: null },
  },
  { minimize: false, versionKey: false, timestamps: true },
);

/** L'écran du projet : « que dois-je encore à ce client ? ». */
paymentRequestSchema.index({ projectId: 1, status: 1, createdAt: -1 }, { name: 'project_status' });

/**
 * LA FILE DES RELANCES — « qu'y a-t-il à envoyer maintenant ? ».
 *
 * Sur le chemin de l'ordonnanceur, qui la parcourt à chaque tour. Sans elle,
 * chaque tour balaierait toutes les demandes du parc pour n'en trouver aucune.
 */
paymentRequestSchema.index(
  { status: 1, 'reminders.enabled': 1, 'reminders.nextAt': 1 },
  { name: 'reminder_queue' },
);

/**
 * LA CONVERGENCE — retrouver la demande depuis ce que Stripe annonce.
 *
 * Le webhook porte une session, jamais notre identifiant. Sans cet index, le
 * passage à `PAID` balaierait la collection à chaque paiement du parc.
 */
paymentRequestSchema.index(
  { 'stripe.checkoutSessionId': 1 },
  { name: 'by_checkout_session', sparse: true },
);
paymentRequestSchema.index(
  { 'stripe.paymentIntentId': 1 },
  { name: 'by_payment_intent', sparse: true },
);

export const PanelPaymentRequest = mongoose.model('PanelPaymentRequest', paymentRequestSchema);

export default PanelPaymentRequest;
