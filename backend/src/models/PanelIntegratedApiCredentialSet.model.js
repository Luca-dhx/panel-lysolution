// JEU D'IDENTIFIANTS D'UN FOURNISSEUR — le coffre du plan de contrôle (L1).
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md §4.2.
//
// ── POURQUOI UN NOUVEAU MODÈLE, ET NON UNE EXTENSION ────────────────────────
//
// `PanelIntegratedApi` existe déjà. Il n'est pas repris, pour trois raisons
// qu'aucune migration de champ ne corrige :
//
//  1. Son `provider` et sa `key` sont des CHAÎNES LIBRES. Rien n'y empêche
//     « Stripe » et « STRIPE » de coexister comme deux intégrations. Un plan
//     de contrôle a besoin d'un fournisseur typé, adossé au registre.
//  2. Il porte `grants[]` et une logique de DIFFUSION de secrets vers les
//     projets — exactement ce que la cible interdit. L'étendre reviendrait à
//     bâtir la fondation sur ce qu'on veut démolir (L4).
//  3. Son unité est « une API d'entreprise avec deux modes ». La nôtre est
//     « un jeu d'identifiants, pour une portée ». Ce ne sont pas les mêmes
//     objets, et les confondre empêche `PANEL_GLOBAL` d'exister proprement.
//
// L'ancien modèle reste EN PLACE et INTACT pendant toute la migration
// (compatibilité L1). Les deux collections coexistent volontairement.
//
// ── CE QUI EST STOCKÉ, ET CE QUI NE L'EST JAMAIS ────────────────────────────
//
// `credentialsEncrypted` : { rôle → valeur chiffrée AES-256-GCM }. Aucune
// valeur en clair, jamais, y compris pour les rôles non confidentiels — le
// chiffrement est uniforme parce qu'une exception est une chose qu'on oublie.
//
// `fingerprints` : empreinte courte NON réversible. Elle répond à la seule
// question utile sans lire le secret : « ai-je bien remplacé cette clé ? ».
//
// `lastFour` : les quatre derniers caractères d'une valeur confidentielle.
// Assez pour reconnaître une clé, très loin d'assez pour s'en servir.
import mongoose from 'mongoose';

import { SCOPE_VALUES, ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

/** États possibles d'un jeu. Catalogue FERMÉ — l'interface s'appuie dessus. */
export const CREDENTIAL_SET_STATUS = Object.freeze({
  /** Aucun identifiant renseigné. */
  EMPTY: 'EMPTY',
  /** Tous les rôles requis sont présents, mais rien ne prouve qu'ils marchent. */
  CONFIGURED: 'CONFIGURED',
  /** Une validation a RÉUSSI, et pour les valeurs actuellement en place. */
  VALID: 'VALID',
  /** Une validation a été REFUSÉE par le fournisseur (clé fausse, droits). */
  INVALID: 'INVALID',
  /** La validation n'a pas pu aboutir (réseau, délai, panne fournisseur). */
  ERROR: 'ERROR',
});

export const CREDENTIAL_SET_STATUS_VALUES = Object.freeze(Object.values(CREDENTIAL_SET_STATUS));

/** Une valeur d'identifiant. Toujours chiffrée, jamais lisible depuis ici. */
const credentialValueSchema = new mongoose.Schema(
  {
    // Format « iv.tag.ciphertext » (hex), produit par `panelCrypto`.
    encrypted: { type: String, required: true },
    // sha256 tronquée — constate un changement, ne permet pas de lire.
    fingerprint: { type: String, default: '' },
    // Quatre derniers caractères. Vide pour un rôle confidentiel très court.
    lastFour: { type: String, default: '' },
    // Le rôle était-il déclaré confidentiel AU MOMENT de l'écriture ? On le
    // fige : si le registre changeait d'avis, une valeur écrite comme secrète
    // ne doit pas devenir lisible rétroactivement.
    secret: { type: Boolean, default: true },
    updatedAt: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { _id: false },
);

const integratedApiCredentialSetSchema = new mongoose.Schema(
  {
    credentialSetId: { type: String, required: true, unique: true },

    // Fournisseur TYPÉ. L'enum n'est pas déclarée ici avec la liste du
    // registre : un `enum` mongoose figé casserait la lecture d'un document
    // écrit par une version qui connaissait un fournisseur de plus. La
    // validation d'appartenance au registre est faite par le service, à
    // l'écriture — là où l'on peut refuser proprement.
    provider: { type: String, required: true, uppercase: true, trim: true },

    scope: { type: String, required: true, enum: SCOPE_VALUES },

    /**
     * `null` pour un fournisseur PANEL_GLOBAL. Un `null` n'entre PAS dans un
     * index unique partiel de la même manière qu'une valeur : d'où l'index
     * dédié plus bas, et l'invariant vérifié par le service.
     */
    environment: { type: String, enum: [...ENVIRONMENTS, null], default: null },

    /** Réservé aux portées PROJECT* — aucun fournisseur actuel ne l'emploie. */
    projectId: { type: String, default: null },

    credentialsEncrypted: { type: Map, of: credentialValueSchema, default: () => new Map() },

    status: {
      type: String,
      enum: CREDENTIAL_SET_STATUS_VALUES,
      default: CREDENTIAL_SET_STATUS.EMPTY,
    },

    /**
     * Dernière VALIDATION — un appel réel, non destructif, au fournisseur.
     * `lastValidatedFingerprint` prouve que le verdict porte sur les valeurs
     * ACTUELLEMENT en place : sans lui, un « valide » pourrait dater d'une clé
     * remplacée depuis. C'est le même garde-fou que côté projet.
     */
    lastValidatedAt: { type: String, default: null },
    lastValidationCode: { type: String, default: null },
    lastValidationMessage: { type: String, default: '' },
    lastValidationDurationMs: { type: Number, default: null },
    lastValidatedFingerprint: { type: String, default: '' },
    /** Diagnostic NON sensible du dernier appel (compte, pays, version d'API…). */
    lastValidationDetails: { type: mongoose.Schema.Types.Mixed, default: null },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    updatedBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * UNICITÉ — un seul jeu par (fournisseur, environnement, projet).
 *
 * Mongo traite deux `null` comme deux valeurs égales dans un index unique :
 * un fournisseur global ne peut donc pas avoir deux jeux, ce qui est
 * exactement la garantie voulue. Et un fournisseur par environnement ne peut
 * pas avoir deux jeux TEST.
 */
integratedApiCredentialSetSchema.index(
  { provider: 1, environment: 1, projectId: 1 },
  { unique: true, name: 'uniq_provider_environment_project' },
);

export const PanelIntegratedApiCredentialSet = mongoose.model(
  'PanelIntegratedApiCredentialSet',
  integratedApiCredentialSetSchema,
);

export default PanelIntegratedApiCredentialSet;
