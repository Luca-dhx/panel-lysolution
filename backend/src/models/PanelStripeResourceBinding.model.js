// LIEN PROJET ↔ RESSOURCE STRIPE — l'autorité d'appartenance (L6.2A).
//
// docs/architecture/STRIPE_L6_2A_RESOURCE_OWNERSHIP_REPORT.md.
//
// ── CE QUE CE DOCUMENT RÉPOND, ET QU'AUCUN AUTRE NE SAIT ────────────────────
//
//   « ce `cus_…` appartient-il à CE projet, dans CE monde ? »
//
// Le compte Stripe du Panel est partagé par tout le parc. Sans ce document,
// n'importe quel projet appairé pourrait lire les factures — ou résilier
// l'abonnement — d'un autre client, simplement en présentant son identifiant.
// Un credential centralisé sans registre d'appartenance est un pouvoir
// centralisé : c'est exactement ce que L6.1 avait identifié comme blocage.
//
// ── POURQUOI IL EST IMMUABLE ────────────────────────────────────────────────
//
// Un lien ne se « corrige » pas. Une ressource Stripe appartient au projet pour
// lequel elle a été créée, définitivement : un client Stripe ne change pas de
// propriétaire parce qu'on s'est trompé de projet en le créant. Autoriser une
// réassignation ouvrirait la seule voie par laquelle un projet pourrait, un
// jour, récupérer la ressource d'un autre.
//
// D'où : aucune mise à jour de `projectId`, aucune suppression douce. Si un lien
// est faux, c'est la RESSOURCE qui est fausse — on en crée une autre, et
// l'ancienne reste attribuée à qui elle l'a toujours été. Le seul état terminal
// admis est `revokedAt`, qui NEUTRALISE sans réattribuer (§« Révocation »).
//
// ── CE QU'IL NE CONTIENT JAMAIS ─────────────────────────────────────────────
//
// Aucun secret, aucun montant, aucune donnée personnelle. Un identifiant Stripe
// (`cus_…`) n'est pas un secret — il ne donne aucun accès sans la clé — mais il
// désigne un client, et c'est déjà une raison de ne pas le diffuser en liste.
import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

/**
 * FAMILLES DE RESSOURCES — code-first, fermé.
 *
 * Une chaîne libre laisserait un appelant inventer `CUSTOMER_V2` et créer un
 * lien qu'aucune vérification ne consulterait. La liste est celle de l'audit
 * L6.1 : les objets que le parc manipule réellement.
 *
 * `PRODUCT` et `PRICE` en font partie alors qu'aucune capacité ne les expose :
 * ils sont créés par le Panel pour figer un tarif, et un objet créé sans lien
 * serait un orphelin qu'aucun inventaire ne rattacherait plus tard.
 */
export const STRIPE_RESOURCE_TYPES = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  CHECKOUT_SESSION: 'CHECKOUT_SESSION',
  SUBSCRIPTION: 'SUBSCRIPTION',
  PAYMENT_INTENT: 'PAYMENT_INTENT',
  INVOICE: 'INVOICE',
  PRODUCT: 'PRODUCT',
  PRICE: 'PRICE',
});

export const STRIPE_RESOURCE_TYPE_VALUES = Object.freeze(Object.values(STRIPE_RESOURCE_TYPES));

/**
 * D'OÙ VIENT LE LIEN — et cette colonne décide de la confiance qu'on lui porte.
 *
 * `PANEL_CREATED` est la seule source qui prouve l'appartenance : le Panel a
 * exécuté la création lui-même, pour un projet identifié, dans un monde connu.
 *
 * Les deux autres sont des ADOPTIONS de ressources antérieures. Elles ne sont
 * pas moins vraies, mais elles reposent sur une corrélation — et une
 * corrélation se vérifie, elle ne se suppose pas.
 */
export const BINDING_SOURCES = Object.freeze({
  /** Le Panel a créé la ressource. Preuve par construction. */
  PANEL_CREATED: 'PANEL_CREATED',
  /** Adoptée après vérification croisée par un opérateur (métadonnée + projection). */
  IMPORTED_WITH_PROOF: 'IMPORTED_WITH_PROOF',
  /** Apprise d'un événement fournisseur, corroborée par une projection. */
  LEARNED_FROM_WEBHOOK: 'LEARNED_FROM_WEBHOOK',
});

export const BINDING_SOURCE_VALUES = Object.freeze(Object.values(BINDING_SOURCES));

const bindingSchema = new mongoose.Schema(
  {
    /** Le projet PROPRIÉTAIRE. Vient du contexte authentifié, jamais d'un corps. */
    projectId: { type: String, required: true, index: true },

    /**
     * LE MONDE. Strictement séparé : un `cus_` de recette et un `cus_` de
     * production ne se ressemblent que par leur préfixe, et confondre les deux
     * reviendrait à agir en production sur un objet de test.
     */
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    resourceType: { type: String, required: true, enum: STRIPE_RESOURCE_TYPE_VALUES },

    /**
     * L'identifiant Stripe, tel que Stripe le rend. Jamais normalisé en
     * minuscules : les identifiants Stripe sont sensibles à la casse, et les
     * « nettoyer » créerait deux formes pour un même objet.
     */
    resourceId: { type: String, required: true },

    source: { type: String, required: true, enum: BINDING_SOURCE_VALUES },

    /**
     * L'OPÉRATION QUI A CRÉÉ LA RESSOURCE — la jonction avec le registre
     * d'idempotence du plan de contrôle.
     *
     * C'est ce champ qui permet, après un rejeu, de retrouver le lien déjà posé
     * au lieu d'en créer un second : même `operationId`, même ressource, même
     * ligne. Nul pour une adoption — il n'y a pas eu d'opération.
     */
    createdByOperationId: { type: String, default: null },

    /**
     * De quoi une adoption tire sa preuve. Vide pour `PANEL_CREATED`.
     * Ne porte que des identifiants internes — jamais un montant, jamais un nom.
     */
    proof: {
      /** `metadata.contractId` lu sur l'objet Stripe. */
      stripeMetadataContractId: { type: String, default: null },
      /** La projection de contrat qui a corroboré, côté Panel. */
      matchedProjectionContractId: { type: String, default: null },
      /** Qui a validé l'adoption. Une adoption reste un acte humain. */
      approvedBy: { type: String, default: null },
    },

    /**
     * NEUTRALISATION, pas suppression.
     *
     * Une ressource peut cesser d'être utilisable — client supprimé chez
     * Stripe, abonnement clos, session expirée. Le lien reste : il est la
     * mémoire de qui la possédait. `revokedAt` empêche seulement de s'en servir
     * pour autoriser une opération.
     *
     * Il ne libère JAMAIS l'identifiant : l'index unique tient toujours, donc
     * personne ne peut réattribuer la ressource à un autre projet en la
     * révoquant d'abord.
     */
    revokedAt: { type: String, default: null },
    revokedReason: { type: String, default: null },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * L'INDEX QUI PORTE TOUTE LA GARANTIE.
 *
 * Unique sur (environnement, type, identifiant) — SANS le projet. C'est
 * délibéré et c'est le cœur du lot : inclure `projectId` autoriserait deux
 * lignes pour la même ressource et deux propriétaires différents, ce qui est
 * exactement la situation qu'on veut rendre impossible.
 *
 * L'unicité est arbitrée par la BASE, pas par une lecture suivie d'une
 * écriture : deux créations concurrentes pour la même ressource ne peuvent pas
 * gagner toutes les deux.
 */
bindingSchema.index(
  { environment: 1, resourceType: 1, resourceId: 1 },
  { unique: true, name: 'stripe_resource_unique' },
);

/** Lecture par projet — la question « que possède ce projet ? ». */
bindingSchema.index({ projectId: 1, environment: 1, resourceType: 1 });

/** Retrouver le lien d'une opération rejouée, sans connaître la ressource. */
bindingSchema.index({ createdByOperationId: 1 });

export const PanelStripeResourceBinding = mongoose.model(
  'PanelStripeResourceBinding',
  bindingSchema,
);

export default PanelStripeResourceBinding;
