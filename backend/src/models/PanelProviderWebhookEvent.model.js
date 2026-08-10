// ÉVÉNEMENT FOURNISSEUR REÇU — la primitive d'idempotence (L5).
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Idempotence ».
//
// ── CE QUE CE MODÈLE EST ────────────────────────────────────────────────────
//
// Un REGISTRE DE RÉCEPTION, et rien de plus. Il répond à une question :
// « ai-je déjà vu cet événement ? ». Les fournisseurs rejouent — Stripe avec
// backoff, Yousign avec `auto_retry`, Brevo à sa guise — et un rejeu ne doit
// pas produire deux fois le même effet.
//
// ── CE QUE CE MODÈLE N'EST PAS ──────────────────────────────────────────────
//
// Ce n'est PAS un bus métier. Aucun `PAYMENT_SUCCEEDED`, aucun dispatch, aucune
// normalisation vers un vocabulaire de capacité : cela appartient à L6/L7/L8,
// qui possèdent les providers correspondants. L5 fournit la primitive sur
// laquelle ils s'appuieront ; construire leur table de correspondance ici
// reviendrait à cacher trois lots dans celui-ci.
//
// ── LE CORPS N'EST PAS CONSERVÉ ─────────────────────────────────────────────
//
// `payloadHash` seulement. Le corps d'un webhook porte des données
// personnelles ; le garder exigerait une durée de rétention, une politique
// d'effacement et une raison. L'empreinte suffit à ce que ce registre doit
// faire : distinguer un rejeu identique d'un événement neuf.
import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

/** Issue d'une réception. Fermé. */
export const WEBHOOK_EVENT_STATUS = Object.freeze({
  /** Premier passage : l'événement est enregistré. */
  RECEIVED: 'RECEIVED',
  /** Déjà connu : le rejeu est absorbé, aucun effet supplémentaire. */
  DUPLICATE: 'DUPLICATE',
});

export const WEBHOOK_EVENT_STATUS_VALUES = Object.freeze(Object.values(WEBHOOK_EVENT_STATUS));

const providerWebhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, uppercase: true, trim: true },
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    /**
     * Identifiant d'événement CÔTÉ FOURNISSEUR, ou empreinte du corps brut
     * quand le fournisseur n'en fournit aucun (Brevo). Dans les deux cas :
     * stable pour un même événement, différent pour deux événements distincts.
     */
    providerEventId: { type: String, required: true },

    /** Le binding par lequel il est entré — le lien vers le plan de contrôle. */
    bindingId: { type: String, default: null },

    /** Type BRUT du fournisseur, conservé pour le forensic. Jamais traduit ici. */
    eventType: { type: String, default: '' },

    /** Empreinte du corps brut. Jamais le corps. */
    payloadHash: { type: String, default: '' },

    /**
     * L'appel a-t-il été PROUVÉ cryptographiquement ?
     *
     * `false` n'implique pas « rejeté » : un webhook Brevo authentifié par
     * jeton partagé est accepté et marqué non prouvé. La nuance est conservée
     * en base parce qu'elle change la confiance qu'on peut lui accorder, et
     * qu'un jour on voudra la retrouver.
     */
    signatureVerified: { type: Boolean, default: false },

    status: {
      type: String,
      enum: WEBHOOK_EVENT_STATUS_VALUES,
      default: WEBHOOK_EVENT_STATUS.RECEIVED,
    },

    receivedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * L'IDEMPOTENCE EST PORTÉE PAR L'INDEX, PAS PAR UN `findOne` PRÉALABLE.
 *
 * Deux livraisons concurrentes du même événement — cas réel avec le backoff
 * d'un fournisseur — passeraient toutes deux un test d'existence avant que
 * l'une ait écrit. Seule une contrainte unique en base tranche : la seconde
 * insertion reçoit un E11000, et c'est CE refus qui prouve le doublon.
 *
 * La clé inclut l'environnement : un même identifiant d'événement peut exister
 * dans deux comptes fournisseur distincts.
 */
providerWebhookEventSchema.index(
  { provider: 1, environment: 1, providerEventId: 1 },
  { unique: true, name: 'uniq_provider_environment_event' },
);

/** Lecture d'exploitation : « qu'a-t-on reçu récemment sur ce binding ? ». */
providerWebhookEventSchema.index({ bindingId: 1, receivedAt: -1 }, { name: 'binding_recent' });

export const PanelProviderWebhookEvent = mongoose.model(
  'PanelProviderWebhookEvent',
  providerWebhookEventSchema,
);

export default PanelProviderWebhookEvent;
