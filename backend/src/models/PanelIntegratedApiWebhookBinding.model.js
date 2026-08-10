// LIAISON WEBHOOK — l'état d'un endpoint chez un fournisseur (L5).
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Modèle ».
//
// ── CE QUE CE DOCUMENT RÉPOND, ET QU'AUCUN AUTRE NE SAIT ────────────────────
//
//   ce que le Panel VEUT           → desiredUrl, desiredEvents
//   ce que le fournisseur EXPOSE   → observedUrl, observedEvents, remoteWebhookId
//   quand on a regardé             → lastCheckedAt
//   quand on a agi                 → lastReconciledAt
//   ce qui a échoué                → lastErrorCode, lastErrorMessage, lastErrorAt
//   ce qu'il reste à faire         → status + drift[]
//
// La distinction désiré/observé est la raison d'être du modèle. Un `webhookId`
// seul ne prouve RIEN : il prouve qu'on a créé un endpoint un jour, pas qu'il
// existe encore, ni qu'il pointe où il faut, ni qu'il écoute les bons
// événements. C'est exactement l'illusion qu'on refuse ici.
//
// ── CE QUI N'Y EST JAMAIS ───────────────────────────────────────────────────
//
// Aucun secret, même chiffré : le secret de signature vit dans le coffre
// (`PanelIntegratedApiCredentialSet`, rôle `webhookSecret`). Deux endroits pour
// un même secret, c'est un endroit de trop à sécuriser, à faire tourner, et à
// oublier.
//
// Aucun payload d'événement. Le corps d'un webhook contient des données
// personnelles (adresses, montants, identités de signataires) : le conserver
// exigerait une durée de rétention, une politique d'effacement et une raison.
// Nous n'en avons pas — nous n'en gardons donc qu'une empreinte, ailleurs
// (`PanelProviderWebhookEvent`).
import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';
import { WEBHOOK_STATUS, WEBHOOK_STATUS_VALUES } from '../services/webhooks/webhookDiagnostics.js';

/** Formes de divergence reconnues. Fermé : l'écran les traduit une par une. */
export const WEBHOOK_DRIFT_KINDS = Object.freeze({
  URL: 'URL',
  EVENTS: 'EVENTS',
  DISABLED: 'DISABLED',
  DESCRIPTION: 'DESCRIPTION',
  /** Notre endpoint a disparu de chez le fournisseur (supprimé à la main). */
  MISSING: 'MISSING',
});

const webhookBindingSchema = new mongoose.Schema(
  {
    bindingId: { type: String, required: true, unique: true },

    // Typés par le registre, mais sans `enum` mongoose : un enum figé casserait
    // la LECTURE d'un document écrit par une version qui connaissait un
    // fournisseur de plus. Le service refuse à l'écriture, là où c'est lisible.
    provider: { type: String, required: true, uppercase: true, trim: true },
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    /**
     * PREUVE D'APPARTENANCE — un UUID que NOUS avons frappé, et que nous seuls
     * connaissons. Il part chez le fournisseur dans la description de
     * l'endpoint, et il revient dans `list()`. Le préfixe canonique dit
     * « un Panel gère ceci » ; ce jeton dit « CE Panel-ci ».
     *
     * Il est écrit AVANT le premier appel de création : un processus tué entre
     * la frappe et la réponse laisse un endpoint orphelin que le passage
     * suivant saura reconnaître comme le sien, au lieu de le prendre pour
     * l'endpoint d'un tiers et de créer un doublon à côté.
     */
    ownershipToken: { type: String, required: true },

    /** Identifiant de l'endpoint CHEZ le fournisseur. `null` tant qu'absent. */
    remoteWebhookId: { type: String, default: null },

    /** Segment de route qui reçoit — figé par le registre, recopié pour l'audit. */
    callbackSlug: { type: String, default: '' },

    // ── ÉTAT DÉSIRÉ ────────────────────────────────────────────────────────
    desiredUrl: { type: String, default: '' },
    desiredEvents: { type: [String], default: () => [] },

    // ── ÉTAT OBSERVÉ (dernière lecture réelle chez le fournisseur) ─────────
    observedUrl: { type: String, default: '' },
    observedEvents: { type: [String], default: () => [] },
    observedEnabled: { type: Boolean, default: null },
    observedDescription: { type: String, default: '' },

    status: {
      type: String,
      enum: WEBHOOK_STATUS_VALUES,
      default: WEBHOOK_STATUS.PENDING,
    },

    /** Divergences constatées. Vide quand `status === READY`. */
    drift: { type: [String], default: () => [] },

    /**
     * Le secret de signature est-il en place DANS LE COFFRE ?
     *
     * Un booléen, jamais la valeur, jamais une empreinte partielle. Il répond à
     * la seule question qui compte pour l'exploitation : « saurais-je vérifier
     * un événement qui arrive maintenant ? ».
     */
    secretConfigured: { type: Boolean, default: false },

    lastCheckedAt: { type: String, default: null },
    lastReconciledAt: { type: String, default: null },
    lastErrorCode: { type: String, default: null },
    lastErrorMessage: { type: String, default: '' },
    lastErrorAt: { type: String, default: null },

    /** Observabilité de la RÉCEPTION — le seul signe qu'un webhook vit. */
    lastEventAt: { type: String, default: null },
    lastEventType: { type: String, default: null },
    eventsReceived: { type: Number, default: 0 },
    duplicatesIgnored: { type: Number, default: 0 },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * UNICITÉ — un seul endpoint géré par (fournisseur, environnement).
 *
 * C'est la traduction en base de la décision d'architecture qui justifie tout
 * le lot : **un** endpoint Panel par compte fournisseur et par monde, quel que
 * soit le nombre de projets. Le plafond Stripe de 16 endpoints par compte
 * cesse alors d'être une limite de croissance (roadmap §8.2).
 *
 * L'index REND CETTE RÈGLE IMPOSSIBLE À CONTOURNER, y compris par un appel
 * concurrent : deux réconciliations simultanées ne peuvent pas produire deux
 * bindings, donc pas deux endpoints distants.
 */
webhookBindingSchema.index(
  { provider: 1, environment: 1 },
  { unique: true, name: 'uniq_provider_environment' },
);

export const PanelIntegratedApiWebhookBinding = mongoose.model(
  'PanelIntegratedApiWebhookBinding',
  webhookBindingSchema,
);

export default PanelIntegratedApiWebhookBinding;
