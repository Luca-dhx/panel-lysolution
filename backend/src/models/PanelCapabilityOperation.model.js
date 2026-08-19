// REGISTRE DES OPÉRATIONS — l'idempotence que Brevo n'offre pas (L8.3).
//
// docs/architecture/CAPABILITY_GATEWAY.md §« Idempotence ».
//
// ── POURQUOI CE REGISTRE EXISTE ─────────────────────────────────────────────
//
// Stripe accepte un en-tête `Idempotency-Key` : rejouer y est sûr, le
// fournisseur déduplique. Brevo n'offre RIEN de tel sur `POST /v3/smtp/email`
// (audit L8 §7). La déduplication est donc entièrement la nôtre — et si elle
// n'existe pas, deux clics envoient deux e-mails à une personne réelle.
//
// ── LA CLÉ, ET POURQUOI ELLE PORTE LE PROJET ────────────────────────────────
//
// `(projectId, capability, operationId)`. Le projet en fait partie parce que
// `operationId` est frappé par le projet : deux projets peuvent légitimement
// choisir le même identifiant, et les confondre ferait taire l'envoi du second.
// La capacité en fait partie pour la même raison — un même identifiant
// d'opération métier peut légitimement déclencher deux verbes différents.
//
// ── LES QUATRE ÉTATS, ET CELUI QUI COMPTE VRAIMENT ──────────────────────────
//
//   PENDING    l'exécution est en cours. Un second appel concurrent ne doit
//              PAS partir : il attend ou il est refusé, jamais il double.
//   SUCCEEDED  le fournisseur a accepté. Un rejeu rend le résultat CONSERVÉ,
//              et n'envoie rien.
//   FAILED     refus CERTAIN, avant acceptation. Rien n'est parti : rejouer
//              est légitime si la cause a été corrigée.
//   UNKNOWN    l'issue est INDÉCIDABLE — délai dépassé, réponse perdue. La
//              requête a pu aboutir. C'est le seul état qui interdit tout
//              rejeu automatique : le trancher est un arbitrage humain.
//
// Ranger UNKNOWN dans FAILED serait l'erreur classique, et la plus coûteuse :
// elle transforme un doute en certitude, fait rejouer, et double une action
// réelle chez un destinataire.
//
// ── CE QUI N'EST PAS ÉCRIT ICI ──────────────────────────────────────────────
//
// Aucun contenu d'e-mail, aucune variable métier, aucun sujet rendu. Le Panel
// est un TRANSPORT : recopier chez lui le message lu par l'utilisateur créerait
// un second historique métier à réconcilier, et deux historiques qui divergent
// valent moins qu'un seul. L'adresse du destinataire n'y figure que sous forme
// d'empreinte — assez pour rapprocher, jamais pour lire.
import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

export const OPERATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

export const OPERATION_STATUS_VALUES = Object.freeze(Object.values(OPERATION_STATUS));

/** Un rejeu automatique est-il permis depuis cet état ? */
export function mayReplay(status) {
  // FAILED seulement : rien n'est parti, la cause est connue, et l'appelant a
  // pu la corriger. Tous les autres états ou bien ont déjà produit l'effet,
  // ou bien ne permettent pas de savoir s'il a été produit.
  return status === OPERATION_STATUS.FAILED;
}

const panelCapabilityOperationSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true },
    capability: { type: String, required: true },
    /** Frappé par le PROJET : lui seul sait que deux clics sont une intention. */
    operationId: { type: String, required: true },

    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },
    provider: { type: String, required: true, uppercase: true },

    status: {
      type: String,
      enum: OPERATION_STATUS_VALUES,
      default: OPERATION_STATUS.PENDING,
    },

    /**
     * La poignée de corrélation du suivi de livraison, sous forme CANONIQUE.
     * C'est par elle qu'un webhook Brevo retrouvera l'opération, donc le
     * projet à qui rendre l'événement.
     */
    providerMessageId: { type: String, default: null },

    /** Empreinte du destinataire — jamais l'adresse. */
    recipientHash: { type: String, default: '' },
    /** Code du template exécuté. Un code métier, jamais un identifiant Brevo. */
    templateCode: { type: String, default: null },

    /**
     * QUEL DOCUMENT EXACT EST PARTI (L11.1).
     *
     * ── POURQUOI CES TROIS CHAMPS, ET POURQUOI ICI ────────────────────────────
     *
     * Le code seul ne suffisait plus le jour où trois documents ont pu le
     * porter. « Un PASSWORD_RESET_REQUEST est parti » ne dit pas LEQUEL : celui
     * du Panel, celui de SB Auto, ou celui d'un autre client — ni dans quelle
     * version. C'est précisément la question qu'un exploitant pose quand un
     * client signale un e-mail au mauvais nom, et elle n'avait pas de réponse.
     *
     * Ils sont écrits À L'ABOUTISSEMENT, pas à la réservation : la réservation
     * précède le rendu, et à ce moment-là personne ne sait encore quelle version
     * partira. Écrire une valeur devinée serait pire que de ne rien écrire.
     *
     * `null` sur une opération non aboutie, et sur toute capacité qui n'est pas
     * un envoi de modèle. Ce ne sont pas des données personnelles : ce sont des
     * coordonnées de document.
     */
    templateScope: { type: String, enum: ['PANEL', 'PROJECT', null], default: null },
    templateScopeId: { type: String, default: null },
    templateVersion: { type: Number, default: null },

    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: '' },
    httpStatus: { type: Number, default: null },
    durationMs: { type: Number, default: null },
    attempts: { type: Number, default: 0 },

    startedAt: { type: String, required: true },
    settledAt: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * L'IDEMPOTENCE EST PORTÉE PAR L'INDEX, PAS PAR UNE LECTURE PRÉALABLE.
 *
 * Deux appels concurrents portant le même `operationId` passeraient tous deux
 * un `findOne` avant que l'un ait écrit. Seule la contrainte unique arbitre :
 * la seconde insertion reçoit un E11000, et c'est CE refus qui prouve que
 * quelqu'un d'autre est déjà en train d'envoyer.
 */
panelCapabilityOperationSchema.index(
  { projectId: 1, capability: 1, operationId: 1 },
  { unique: true, name: 'uniq_project_capability_operation' },
);

/** Retrouver l'opération depuis un événement fournisseur (webhook de livraison). */
panelCapabilityOperationSchema.index(
  { provider: 1, environment: 1, providerMessageId: 1 },
  { name: 'by_provider_message', sparse: true },
);

export const PanelCapabilityOperation = mongoose.model(
  'PanelCapabilityOperation',
  panelCapabilityOperationSchema,
);
export default PanelCapabilityOperation;
