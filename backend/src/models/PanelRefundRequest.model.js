import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

/**
 * LA DEMANDE DE REMBOURSEMENT — l'INTENTION, pas le fait (L10.4).
 *
 * ══ POURQUOI UN TROISIÈME REGISTRE ══════════════════════════════════════════
 *
 * Trois choses portent déjà une part de l'histoire d'un remboursement, et
 * aucune ne porte celle-ci :
 *
 *   • `PanelCapabilityOperation` sait qu'un acte a été réservé puis conclu,
 *     mais il ne sait ni sur quelle transaction, ni pour quel motif, ni par
 *     qui. C'est un registre de plan de contrôle, volontairement aveugle au
 *     métier — l'élargir ferait entrer le vocabulaire financier dans L6.
 *   • `PanelProviderRevenueFact` porte ce que STRIPE affirme. Il ne naît qu'au
 *     retour de l'appel, et n'existe donc pas pendant la fenêtre exacte où l'on
 *     a le plus besoin de trace : entre le clic et la réponse.
 *   • Le ledger porte l'argent rendu. Un remboursement qui échoue n'y écrit
 *     rien — et un remboursement qui échoue doit pourtant se lire quelque part.
 *
 * Ce modèle est cette trace. Il naît AVANT tout contact fournisseur, il survit
 * à l'échec, et il est la seule pièce qui réponde à « qui a demandé ce
 * remboursement, quand, pourquoi, et qu'est-il devenu ? ».
 *
 * ══ POURQUOI PAS DANS `PanelEvent` ═════════════════════════════════════════
 *
 * La chronologie du Panel est BORNÉE à 300 entrées par projet (constaté en
 * L10.2) : un remboursement de l'an dernier en sortirait. Une trace financière
 * ne peut pas s'effacer par pression du volume.
 */

/**
 * L'ÉTAT D'UNE DEMANDE. Fermé, et chaque valeur se diagnostique.
 *
 * `UNKNOWN` N'EST PAS `FAILED`, et c'est la distinction la plus importante du
 * lot. Un échec dit « l'argent n'est pas parti » ; un inconnu dit « on ne sait
 * pas ». Les confondre ferait proposer un second remboursement pour un premier
 * peut-être abouti — c'est-à-dire rendre deux fois l'argent.
 */
export const REFUND_REQUEST_STATUS = Object.freeze({
  /** Écrite, aucun appel encore émis. La preuve que l'intention existait. */
  REQUESTED: 'REQUESTED',
  /** L'appel est parti. Toute reprise doit converger, jamais recréer. */
  PROCESSING: 'PROCESSING',
  /** Stripe a rendu un `re_…`. L'argent est parti (ou part, si `pending`). */
  SUCCEEDED: 'SUCCEEDED',
  /** Stripe a tranché : rien n'est parti. Une nouvelle demande est licite. */
  FAILED: 'FAILED',
  /** Aucune réponse exploitable. L'issue est INDÉCIDABLE — on converge. */
  UNKNOWN: 'UNKNOWN',
});

export const REFUND_REQUEST_STATUS_VALUES = Object.freeze(Object.values(REFUND_REQUEST_STATUS));

/** Les seuls états depuis lesquels un nouvel appel fournisseur est permis. */
export const REFUND_REPLAYABLE = Object.freeze([
  REFUND_REQUEST_STATUS.REQUESTED,
  REFUND_REQUEST_STATUS.PROCESSING,
  REFUND_REQUEST_STATUS.UNKNOWN,
]);

/**
 * Un rejeu est-il permis depuis cet état ?
 *
 * `SUCCEEDED` et `FAILED` sont TERMINAUX : Stripe a tranché, et rejouer
 * n'apprendrait rien. `UNKNOWN` l'est au contraire — c'est précisément l'état
 * qu'on rejoue, et l'adaptateur y reconnaîtra son propre acte s'il a abouti.
 */
export function mayReplayRefund(status) {
  return REFUND_REPLAYABLE.includes(String(status));
}

const refundRequestSchema = new mongoose.Schema(
  {
    /**
     * L'IDENTITÉ DE L'ACTE, ÉCRITE AVANT L'APPEL.
     *
     * Ce n'est pas un identifiant technique de ligne : c'est ce dont dérive
     * `operationId`, donc la clé d'idempotence Stripe, donc la métadonnée
     * apposée sur le remboursement. Deux clics sur la même demande la rejouent ;
     * deux demandes distinctes sont deux remboursements légitimes.
     */
    refundRequestId: { type: String, required: true, unique: true },

    /** L'identité dérivée, telle qu'envoyée au plan de contrôle. Journalisée. */
    operationId: { type: String, required: true },

    /** Le périmètre. Jamais `null` : on ne rembourse pas L.Y Solution. */
    projectId: { type: String, required: true },

    /**
     * LE MOUVEMENT D'ORIGINE, DÉSIGNÉ PAR SON IDENTITÉ INTERNE.
     *
     * C'est le SEUL désignant que le navigateur fournisse. Les identifiants
     * Stripe — intention, débit, facture — sont résolus côté serveur depuis le
     * fait fournisseur, jamais acceptés d'un client. Voir l'orchestration.
     */
    sourceTransactionId: { type: String, required: true },

    /**
     * LE MONDE, DÉRIVÉ DU PAIEMENT D'ORIGINE — jamais choisi par un écran.
     * Conservé ici pour que la demande reste lisible sans relire le paiement.
     */
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    /** Résolus côté serveur, conservés pour l'audit. */
    paymentIntentId: { type: String, default: null },

    /** En centimes, positif. `null` = remboursement TOTAL du restant. */
    amountCents: { type: Number, default: null },
    currency: { type: String, required: true },

    /** Le motif Stripe, parmi les trois qu'il accepte. Facultatif. */
    providerReason: { type: String, default: null },
    /**
     * LA RAISON DE L'OPÉRATEUR — libre, et elle NE PART PAS chez Stripe.
     *
     * Le fournisseur n'accepte que trois motifs codifiés. Une explication utile
     * (« erreur de facturation sur la prestation de juin ») n'y entrerait pas,
     * et surtout n'y serait plus lisible sans compte Stripe. Elle reste ici.
     */
    operatorReason: { type: String, default: null },

    status: {
      type: String,
      enum: REFUND_REQUEST_STATUS_VALUES,
      required: true,
      default: REFUND_REQUEST_STATUS.REQUESTED,
    },

    /** L'identité Stripe du remboursement. `re_…`, JAMAIS celle du paiement. */
    refundId: { type: String, default: null },
    /** L'état chez Stripe (`pending`, `succeeded`…). Distinct du nôtre. */
    providerStatus: { type: String, default: null },
    /** Le mouvement produit dans le ledger, quand la projection a eu lieu. */
    transactionId: { type: String, default: null },

    /** Nommé dès que l'issue n'est pas `SUCCEEDED`. Jamais un état muet. */
    failureCode: { type: String, default: null },
    failureMessage: { type: String, default: null },

    /** Qui a demandé. Une trace financière sans auteur n'en est pas une. */
    requestedBy: {
      userId: { type: String, default: null },
      email: { type: String, default: null },
      name: { type: String, default: null },
    },

    /** Combien de fois l'acte a été rejoué. Un rejeu n'est pas anormal. */
    attempts: { type: Number, default: 0 },

    requestedAt: { type: String, required: true },
    settledAt: { type: String, default: null },
    lastAttemptAt: { type: String, default: null },
  },
  { minimize: false, versionKey: false, timestamps: true },
);

/** L'écran d'un revenu : « que sait-on des remboursements de ce mouvement ? ». */
refundRequestSchema.index({ sourceTransactionId: 1, requestedAt: -1 }, { name: 'by_source' });

/** La supervision : « reste-t-il des demandes en suspens à faire converger ? ». */
refundRequestSchema.index({ status: 1, requestedAt: 1 }, { name: 'by_status' });

/** Diagnostic projet. */
refundRequestSchema.index({ projectId: 1, requestedAt: -1 }, { name: 'project_recent' });

export const PanelRefundRequest = mongoose.model('PanelRefundRequest', refundRequestSchema);

export default PanelRefundRequest;
