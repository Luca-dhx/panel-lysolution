// APPARTENANCE D'UNE DEMANDE DE SIGNATURE — la filiation forte (R10.5C).
//
// docs/R10_5_FINAL_EMAIL_AND_YOUSIGN_CONTROL_PLANE_REPORT.md §4.
//
// ══ LE PROBLÈME QUE CE MODÈLE FERME ═════════════════════════════════════════
//
// Avant la migration, le projet retrouvait le contrat d'un webhook ainsi :
//
//     Contract.findOne({ 'yousign.signatureRequestId': srId })   // srId du payload
//
// Ce n'était PAS un oracle exploitable — la valeur avait été écrite par nous, donc
// un identifiant forgé ne matchait aucun contrat. Mais c'était la SEULE autorité,
// et c'était une metadata fournisseur, alors qu'une filiation plus forte existe :
//
//     projet (jeton de pont)  →  contrat possédé  →  CE LIEN  →  ressource Yousign
//
// Ce modèle est le maillon manquant. Il est écrit par le PANEL, avant tout appel
// fournisseur, et le projet ne peut pas l'écrire lui-même.
//
// ══ POURQUOI UN MODÈLE DÉDIÉ, ET NON `PanelStripeResourceBinding` ═══════════
//
// Le lien Stripe a exactement la bonne forme, et la tentation de le généraliser
// était réelle. Elle a été écartée : ce modèle-là est éprouvé par une suite
// entière qui parle de `cus_`, de `price_` et de sessions de paiement. Le
// rendre polymorphe pour accueillir la signature aurait fait porter à un
// composant financier en production le risque d'une migration juridique.
//
// Le prix est une duplication de forme, assumée et bornée à ce fichier. Le jour
// où un troisième fournisseur demandera la même chose, la généralisation se
// fera sur trois exemples plutôt que sur une intuition.
//
// ══ AUCUNE DONNÉE DE SIGNATURE ICI ══════════════════════════════════════════
//
// Ni nom de signataire, ni adresse, ni contenu de document. Ce lien répond à
// UNE question — « à qui appartient cette demande ? » — et un modèle
// d'appartenance qui accumule des données personnelles devient un second
// registre à protéger et à purger.
import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

/** Ce qui peut être possédé. Fermé : un type hors liste est un refus. */
export const SIGNATURE_RESOURCE_TYPES = Object.freeze({
  /** La demande de signature elle-même — la racine de tout le parcours. */
  REQUEST: 'REQUEST',
});

export const SIGNATURE_RESOURCE_TYPE_VALUES = Object.freeze(
  Object.values(SIGNATURE_RESOURCE_TYPES),
);

/** Comment le lien est né. */
export const SIGNATURE_BINDING_SOURCES = Object.freeze({
  /** Créé par le Panel, au moment d'ouvrir la signature. Le cas normal. */
  CREATED: 'CREATED',
});

export const SIGNATURE_BINDING_SOURCE_VALUES = Object.freeze(
  Object.values(SIGNATURE_BINDING_SOURCES),
);

const bindingSchema = new mongoose.Schema(
  {
    /** Le projet PROPRIÉTAIRE. Vient du contexte authentifié, jamais d'un corps. */
    projectId: { type: String, required: true, index: true },

    /**
     * LE MONDE. Strictement séparé : une demande de recette et une demande de
     * production ne se distinguent que par ce champ, et les confondre
     * reviendrait à agir juridiquement sur la mauvaise.
     */
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    resourceType: {
      type: String,
      required: true,
      enum: SIGNATURE_RESOURCE_TYPE_VALUES,
      default: SIGNATURE_RESOURCE_TYPES.REQUEST,
    },

    /** L'identifiant Yousign, tel que Yousign le rend. Jamais normalisé. */
    resourceId: { type: String, required: true },

    /**
     * LA RÉFÉRENCE MÉTIER DU PROJET — son `contractId`.
     *
     * C'est elle qui rend la filiation utile : le webhook arrive avec un
     * identifiant Yousign, le Panel remonte au projet ET au contrat, et le fait
     * projeté porte les deux. Le projet n'a alors rien à deviner.
     */
    contractRef: { type: String, required: true },

    /**
     * LE DOCUMENT SIGNABLE de cette demande.
     *
     * Conservé parce que le téléchargement du PDF signé l'exige, et qu'il ne
     * doit PAS être fourni par l'appelant : un projet qui nommerait le document
     * à télécharger pourrait tenter d'en lire un autre. Le Panel le connaît
     * depuis la création, donc il le tient.
     */
    documentId: { type: String, default: null },

    source: {
      type: String,
      required: true,
      enum: SIGNATURE_BINDING_SOURCE_VALUES,
      default: SIGNATURE_BINDING_SOURCES.CREATED,
    },

    /**
     * L'OPÉRATION QUI A OUVERT LA DEMANDE — jonction avec le registre
     * d'idempotence.
     *
     * C'est ce champ qui permet, après un rejeu, de retrouver le lien déjà posé
     * plutôt que d'ouvrir une seconde demande de signature — c'est-à-dire de
     * solliciter deux fois une personne réelle.
     */
    createdByOperationId: { type: String, default: null },

    createdAt: { type: String, required: true },
    /** Renseigné quand la demande atteint un état terminal. Jamais supprimé. */
    closedAt: { type: String, default: null },
    closedReason: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * L'INDEX QUI PORTE TOUTE LA GARANTIE.
 *
 * Unique sur (environnement, type, identifiant) — SANS le projet, exactement
 * comme le lien Stripe et pour la même raison : inclure `projectId`
 * autoriserait deux lignes pour la même demande et deux propriétaires
 * différents, ce qui est précisément ce qu'on rend impossible.
 *
 * L'unicité est arbitrée par la BASE, pas par une lecture suivie d'une
 * écriture : deux ouvertures concurrentes ne peuvent pas gagner toutes les deux.
 */
bindingSchema.index(
  { environment: 1, resourceType: 1, resourceId: 1 },
  { unique: true, name: 'signature_resource_unique' },
);

/**
 * UN CONTRAT, UNE DEMANDE VIVANTE.
 *
 * Index unique partiel sur (projet, monde, contrat) tant que la demande n'est
 * pas close. C'est la garantie qui rend le double clic inoffensif AVANT même
 * d'atteindre Yousign : la seconde tentative ne peut pas insérer sa ligne.
 *
 * Partiel, et non total : après un refus ou une expiration, `restartSignature`
 * doit pouvoir ouvrir une NOUVELLE demande pour le même contrat. Un index total
 * l'interdirait, et le contrat resterait bloqué sur son échec.
 */
bindingSchema.index(
  { projectId: 1, environment: 1, contractRef: 1 },
  {
    unique: true,
    name: 'signature_open_request_per_contract',
    partialFilterExpression: { closedAt: null },
  },
);

/** Retrouver le lien d'une opération rejouée, sans connaître la ressource. */
bindingSchema.index({ createdByOperationId: 1 });

export const PanelSignatureBinding = mongoose.model(
  'PanelSignatureBinding',
  bindingSchema,
);
export default PanelSignatureBinding;
