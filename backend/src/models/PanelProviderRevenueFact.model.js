import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

/**
 * FAIT FINANCIER FOURNISSEUR — la boîte de réception, jamais un second ledger.
 *
 * ══ POURQUOI CETTE COLLECTION EXISTE ════════════════════════════════════════
 *
 * Trois raisons, et la première suffirait.
 *
 *  1. LE REGISTRE DE WEBHOOKS NE GARDE PAS LE CORPS. `PanelProviderWebhookEvent`
 *     ne conserve qu'une empreinte, et c'est un choix délibéré (données
 *     personnelles, rétention). On ne peut donc RIEN reprojeter depuis lui : ce
 *     qui n'est pas normalisé à la réception est perdu pour toujours.
 *
 *  2. L'APPARTENANCE N'EST PAS TOUJOURS RÉSOLUBLE À LA RÉCEPTION. Stripe
 *     n'ordonne pas ses livraisons : `invoice.paid` peut précéder
 *     `checkout.session.completed`, et l'abonnement n'est alors pas encore
 *     adopté. Le fait est réel, l'argent est encaissé — seul son propriétaire
 *     manque. Le jeter serait perdre un revenu ; l'attribuer au hasard serait
 *     pire.
 *
 *  3. UN FAIT NON PROJETÉ DOIT RESTER TRAÇABLE. Une ressource sans lien, une
 *     devise non gérée, un monde qui ne concorde pas : chacun de ces cas doit
 *     pouvoir se lire et s'expliquer, plutôt que de disparaître.
 *
 * ══ CE QUE CE N'EST PAS ═════════════════════════════════════════════════════
 *
 * Ce n'est PAS un registre comptable. Rien ici n'est sommé, filtré par période
 * ni affiché dans un total. Le bénéfice se calcule exclusivement sur
 * `PanelFinancialTransaction`, comme depuis L10.1. Cette collection est un SAS :
 * elle retient des faits fournisseur normalisés jusqu'à ce qu'ils puissent
 * devenir — ou ne pas devenir — une transaction.
 *
 * ══ CE QU'ELLE NE STOCKE PAS ════════════════════════════════════════════════
 *
 * La charge utile brute. On extrait ce dont les finances ont besoin — montant,
 * devise, date, identités, libellé — et rien de plus. Recopier l'objet Stripe
 * ferait entrer ici l'adresse du client, ses moyens de paiement et l'identifiant
 * du compte, c'est-à-dire précisément ce que le registre de webhooks refuse de
 * garder.
 */

/** Ce qu'un fait est devenu. Fermé, et chaque valeur se diagnostique. */
export const PROJECTION_STATUS = Object.freeze({
  /** Reçu, normalisé, en attente de son propriétaire. Sera repris. */
  PENDING: 'PENDING',
  /** Devenu une transaction du ledger. `transactionId` la désigne. */
  PROJECTED: 'PROJECTED',
  /** Aucun lien ne revendique la ressource — voir `ownership`. */
  UNOWNED: 'UNOWNED',
  /** Le lien existe mais a été neutralisé : on ne remet rien en circulation. */
  REVOKED: 'REVOKED',
  /** Reconnu financier, hors périmètre de ce lot (remboursement → L10.4). */
  DEFERRED: 'DEFERRED',
  /** Écarté pour une raison nommée : devise, monde, montant nul. */
  SKIPPED: 'SKIPPED',
});

export const PROJECTION_STATUS_VALUES = Object.freeze(Object.values(PROJECTION_STATUS));

const providerRevenueFactSchema = new mongoose.Schema(
  {
    factId: { type: String, required: true, unique: true },

    provider: { type: String, required: true, uppercase: true, trim: true },
    /**
     * LE MONDE, ET IL FAIT PARTIE DE L'IDENTITÉ.
     *
     * Un identifiant Stripe de recette et un de production peuvent coïncider —
     * ce sont deux comptes distincts. Sans l'environnement dans la clé unique,
     * un fait de TEST empêcherait la projection de son homonyme en PROD, ou
     * pire, la remplacerait.
     */
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    /**
     * L'IDENTITÉ CANONIQUE — celle qui dédoublonne quatre annonces en un fait.
     *
     * `INVOICE` quand le paiement est facturé, `CHECKOUT_SESSION` sinon. Le
     * choix est fait par le normalisateur, sur la charge utile seule, et il est
     * le même quel que soit l'événement qui l'apporte. Voir
     * `stripeRevenueNormalizer.js`.
     */
    objectType: { type: String, required: true },
    objectId: { type: String, required: true },

    kind: { type: String, required: true },

    // ── LE FAIT ÉCONOMIQUE ────────────────────────────────────────────────
    /** Toujours ce qui a été PAYÉ, jamais ce qui était dû. Entier, positif. */
    amountCents: { type: Number, default: null },
    currency: { type: String, default: null },
    /** La date du RÈGLEMENT — c'est elle qui décide du mois comptable. */
    occurredAt: { type: Date, default: null },
    label: { type: String, default: null },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },

    // ── APPARTENANCE ──────────────────────────────────────────────────────
    /**
     * PAR QUELLE RESSOURCE L'APPARTENANCE SE PROUVE.
     *
     * Une facture n'a pas de lien à elle : elle hérite de celui de son
     * abonnement. On conserve la ressource porteuse pour pouvoir REJOUER la
     * résolution plus tard — c'est ce qui rend la convergence possible quand
     * l'adoption arrive après le paiement.
     */
    ownershipResourceType: { type: String, default: null },
    ownershipResourceId: { type: String, default: null },
    /** Le verdict, conservé même négatif. Un fait perdu ne s'explique pas. */
    ownership: { type: String, default: null },
    projectId: { type: String, default: null },
    /** Les metadata désignaient-elles un autre projet que le lien ? */
    claimMismatch: { type: Boolean, default: false },

    /**
     * IDENTITÉS SECONDAIRES — audit, et préparation du lot L10.4.
     *
     * Elles vivent ICI, côté fournisseur, et non sur la transaction : L10.1 a
     * posé que la `provenance` d'un mouvement reste MAIGRE — quatre champs
     * plats. Un remboursement aura besoin du `payment_intent` ou du `charge` ;
     * il les trouvera par le fait, sans que le registre comptable ait eu à
     * porter une structure fournisseur.
     */
    corroboration: {
      subscriptionId: { type: String, default: null },
      paymentIntentId: { type: String, default: null },
      chargeId: { type: String, default: null },
      customerId: { type: String, default: null },
      checkoutSessionId: { type: String, default: null },
      invoiceNumber: { type: String, default: null },
      claimedProjectId: { type: String, default: null },
      contractId: { type: String, default: null },
      paymentType: { type: String, default: null },
      /**
       * L10.5 — LA PRESTATION QUE CE PAIEMENT RÈGLE.
       *
       * Lue dans les metadata Stripe que le Panel a lui-même apposées à
       * l'ouverture de la session. Corroborative comme les autres : elle sert à
       * RETROUVER la demande, jamais à décider de l'appartenance — celle-ci
       * reste prouvée par le registre de liens (L6.2A).
       */
      paymentRequestId: { type: String, default: null },
    },

    /**
     * LE DOCUMENT TEL QUE STRIPE L'EXPOSE — des ADRESSES, pas un fichier.
     *
     * `hostedUrl` et `pdfUrl` sont des liens Stripe signés et expirables. Ils
     * ne sont ni servis, ni republiés, ni transformés en média : ils sont
     * conservés pour qu'un opérateur autorisé puisse être renvoyé vers la
     * facture d'origine. La matérialisation d'une copie privée relève d'une
     * décision explicite — voir la doctrine.
     */
    invoiceDocument: {
      invoiceId: { type: String, default: null },
      number: { type: String, default: null },
      hostedUrl: { type: String, default: null },
      pdfUrl: { type: String, default: null },
    },

    /**
     * L10.4 — LE REÇU STRIPE DE LA CHARGE.
     *
     * Il ne vit pas dans `invoiceDocument` parce qu'il n'est pas une facture :
     * c'est une page hébergée que Stripe RÉÉDITE après un remboursement, en y
     * portant les sommes rendues. C'est, pour un `re_…`, le seul document que
     * le fournisseur produise réellement — il n'existe ni PDF ni page propre au
     * remboursement. Voir la doctrine documentaire de L10.4.
     */
    chargeReceiptUrl: { type: String, default: null },

    /**
     * L10.4 — L'ÉTAT DU REMBOURSEMENT CHEZ STRIPE.
     *
     * `pending` n'est PAS un échec : sur prélèvement ou virement, un
     * remboursement reste en attente plusieurs jours. Il est conservé pour que
     * l'écran puisse le dire, jamais pour décider de projeter ou non — un
     * remboursement en cours est un engagement pris, et il compte.
     */
    refundStatus: { type: String, default: null },
    /** Le motif Stripe (`duplicate`, `fraudulent`, `requested_by_customer`). */
    refundReason: { type: String, default: null },
    /**
     * LE FAIT QUE CE REMBOURSEMENT DÉFAIT.
     *
     * L'identité canonique du paiement d'origine, résolue sur nos propres
     * écritures par `corroboration.paymentIntentId`. Elle porte l'appartenance
     * et la filiation comptable — c'est d'elle que la transaction tirera son
     * `parentTransactionId`.
     */
    refundOfObjectType: { type: String, default: null },
    refundOfObjectId: { type: String, default: null },
    refundOfTransactionId: { type: String, default: null },

    // ── PROJECTION ────────────────────────────────────────────────────────
    projectionStatus: {
      type: String,
      enum: PROJECTION_STATUS_VALUES,
      required: true,
      default: PROJECTION_STATUS.PENDING,
    },
    /** Nommée quand le fait n'est pas projeté. Jamais un statut muet. */
    projectionReason: { type: String, default: null },
    /** La transaction produite. C'est le seul pont vers le ledger. */
    transactionId: { type: String, default: null },
    projectedAt: { type: Date, default: null },

    /**
     * LES ÉVÉNEMENTS QUI ONT PARLÉ DE CE FAIT.
     *
     * Borné à quelques entrées : c'est une trace de diagnostic, pas un journal.
     * Elle répond à « qui a annoncé ce paiement, et dans quel ordre ? », qui est
     * la première question quand une projection surprend.
     */
    seenEvents: {
      type: [{
        providerEventId: { type: String, default: null },
        eventType: { type: String, default: null },
        at: { type: String, default: null },
        _id: false,
      }],
      default: [],
    },

    firstSeenAt: { type: String, required: true },
    lastSeenAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * L'IDENTITÉ CANONIQUE EST UNIQUE — et c'est l'index qui le garantit.
 *
 * Quatre annonces Stripe du même paiement convergent vers la même clé. La
 * première l'insère, les suivantes échouent en E11000 et sont traitées comme
 * des retrouvailles. Un `findOne` préalable laisserait passer deux livraisons
 * concurrentes : toutes deux le trouveraient absent.
 *
 * L'environnement fait partie de la clé : voir le champ.
 */
providerRevenueFactSchema.index(
  { provider: 1, environment: 1, objectType: 1, objectId: 1 },
  { unique: true, name: 'uniq_provider_canonical_object' },
);

/** La file de convergence : « quels faits attendent encore un propriétaire ? ». */
providerRevenueFactSchema.index(
  { projectionStatus: 1, ownershipResourceType: 1, ownershipResourceId: 1 },
  { name: 'pending_by_owner_resource' },
);

/** Diagnostic : « qu'a-t-on reçu pour ce projet, et dans quel état ? ». */
providerRevenueFactSchema.index({ projectId: 1, occurredAt: -1 }, { name: 'project_recent' });

/**
 * L10.4 — « QUEL PAIEMENT CETTE INTENTION A-T-ELLE PRODUIT ? ».
 *
 * C'est la question que pose chaque remboursement en arrivant, et elle est sur
 * le chemin critique : sans elle, résoudre l'appartenance d'un `re_…`
 * balaierait toute la collection. Elle sert aussi à l'écran, qui doit savoir
 * pour un revenu s'il reste quelque chose à rendre.
 */
providerRevenueFactSchema.index(
  { environment: 1, 'corroboration.paymentIntentId': 1 },
  { name: 'by_payment_intent', sparse: true },
);

export const PanelProviderRevenueFact = mongoose.model(
  'PanelProviderRevenueFact',
  providerRevenueFactSchema,
);

export default PanelProviderRevenueFact;
