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

/**
 * QUI REÇOIT — la dimension ajoutée par L6.3A.
 *
 * `PANEL`   l'endpoint pointe vers le Panel (le cas de tous les autres).
 * `PROJECT` l'endpoint pointe vers un projet, mais reste créé, possédé et
 *           réconcilié par le Panel avec SA clé. Le projet n'en reçoit que le
 *           secret de VÉRIFICATION, qui ne permet aucun appel sortant.
 */
export const WEBHOOK_DESTINATION = Object.freeze({
  PANEL: 'PANEL',
  PROJECT: 'PROJECT',
});
export const WEBHOOK_DESTINATION_VALUES = Object.freeze(Object.values(WEBHOOK_DESTINATION));

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
     * QUI REÇOIT LES ÉVÉNEMENTS DE CET ENDPOINT (L6.3A).
     *
     * Jusqu'ici la réponse allait de soi : le Panel. Un endpoint était forcément
     * le sien, et le réconciliateur calculait son URL depuis sa propre
     * configuration. C'est encore le cas de la grande majorité d'entre eux.
     *
     * Stripe impose une exception, et elle est structurelle : le projet reçoit
     * ses propres événements de paiement, parce que le Panel ne les lui relaie
     * pas. L'endpoint pointe donc vers le projet — mais c'est le Panel qui le
     * CRÉE, avec SA clé, et qui en détient l'autorité.
     *
     * D'où cette dimension. Sans elle, un endpoint pointant ailleurs
     * ressemblerait à une dérive d'URL, et le réconciliateur le « corrigerait »
     * en le faisant pointer vers le Panel — coupant net la réception du projet.
     */
    destination: {
      type: String,
      required: true,
      enum: [...WEBHOOK_DESTINATION_VALUES],
      default: WEBHOOK_DESTINATION.PANEL,
    },

    /**
     * À QUEL PROJET, quand la destination est `PROJECT`.
     *
     * `null` pour un endpoint du Panel — et ce n'est pas une commodité : c'est
     * ce `null` qui, dans l'index unique, préserve la règle « un seul endpoint
     * Panel par fournisseur et par monde ».
     */
    projectId: { type: String, default: null },

    /**
     * L'ADRESSE PUBLIQUE CANONIQUE DU PROJET au dernier provisionnement.
     *
     * Conservée pour l'audit et pour le diagnostic : en TEST, un tunnel change
     * d'adresse plusieurs fois par jour, et savoir laquelle a été enregistrée
     * chez le fournisseur est la première question qu'on se pose quand plus
     * rien n'arrive. Vide pour un endpoint du Panel, dont l'adresse se calcule.
     */
    projectPublicUrl: { type: String, default: '' },

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

    /**
     * QUAND le secret a été remplacé pour la dernière fois.
     *
     * Une DATE, pas un secret : c'est elle qui borne la fenêtre pendant
     * laquelle l'ancien jeton reste accepté. La stocker ici plutôt que dans le
     * coffre est délibéré — un horodatage n'est pas une valeur confidentielle,
     * et le mêler aux secrets obligerait à déchiffrer pour lire une date.
     */
    secretRotatedAt: { type: String, default: null },

    /**
     * NOTRE PROPRE URL RÉPOND-ELLE ?
     *
     * Aucun des trois fournisseurs n'offre d'API d'événement de test (audit
     * L8, exigence nº10). Sans cette sonde, « aucun événement reçu » est
     * indiscernable de « le tunnel est tombé », et le diagnostic tourne en
     * rond. Purement informatif : il ne change JAMAIS le statut du binding —
     * un réseau qui hoquette n'est pas une dérive de configuration.
     */
    callbackReachable: { type: Boolean, default: null },
    callbackCheckedAt: { type: String, default: null },

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
 * UNICITÉ — un seul endpoint géré par (fournisseur, monde, destinataire).
 *
 * C'est la traduction en base de la décision d'architecture qui justifie tout
 * le lot L5 : **un** endpoint Panel par compte fournisseur et par monde, quel
 * que soit le nombre de projets. Le plafond Stripe de 16 endpoints par compte
 * cesse alors d'être une limite de croissance (roadmap §8.2).
 *
 * L6.3A AJOUTE DEUX COLONNES, ET NE RETIRE RIEN. Pour un endpoint du Panel,
 * `destination = 'PANEL'` et `projectId = null` : la clé retombe donc
 * exactement sur l'ancienne, et la règle d'origine tient telle quelle. Pour un
 * endpoint de projet, elle devient « un seul par projet et par monde ».
 *
 * L'index REND CES RÈGLES IMPOSSIBLES À CONTOURNER, y compris par un appel
 * concurrent : huit provisionnements simultanés ne peuvent pas produire deux
 * bindings, donc pas deux endpoints distants.
 */
webhookBindingSchema.index(
  { provider: 1, environment: 1, destination: 1, projectId: 1 },
  { unique: true, name: 'uniq_provider_environment_destination_project' },
);

export const PanelIntegratedApiWebhookBinding = mongoose.model(
  'PanelIntegratedApiWebhookBinding',
  webhookBindingSchema,
);

export default PanelIntegratedApiWebhookBinding;
