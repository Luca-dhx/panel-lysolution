import mongoose from 'mongoose';

/**
 * ÉVÉNEMENTS DE SUIVI — réunions, appels, repas, relances.
 *
 * ── À QUI CELA APPARTIENT ───────────────────────────────────────────────────
 * Au Panel, et à lui seul. Ce sont les rendez-vous de NOTRE équipe avec un
 * client — le projet n'en sait rien et n'a pas à en savoir quelque chose.
 * Aucun pont, aucune projection, aucune synchronisation : ce serait publier
 * l'agenda interne chez le client.
 *
 * ── UNE RÉUNION EST UN ÉVÉNEMENT ────────────────────────────────────────────
 * Pas un module séparé. « Réunion », « appel », « déjeuner » sont des TYPES du
 * même objet : même agenda, même confirmation, même historique. Deux systèmes
 * parallèles auraient divergé au premier champ ajouté.
 *
 * ── LE TEMPS NE VAUT PAS CONFIRMATION ───────────────────────────────────────
 * Une heure passée ne prouve rien. Un événement dont l'heure est atteinte
 * devient DUE — « à confirmer » — et attend qu'un humain dise ce qui s'est
 * réellement produit. Le marquer COMPLETED tout seul remplirait l'historique
 * de réunions qui n'ont jamais eu lieu.
 */
export const EVENT_TYPES = Object.freeze([
  'MEETING', 'CALL', 'VIDEO_CALL', 'MEAL', 'FOLLOW_UP', 'OTHER',
]);

export const EVENT_STATUS = Object.freeze({
  PLANNED: 'PLANNED',
  DUE: 'DUE',
  COMPLETED: 'COMPLETED',
  MISSED: 'MISSED',
  CANCELLED: 'CANCELLED',
});

export const EVENT_STATUS_VALUES = Object.freeze(Object.values(EVENT_STATUS));

/**
 * TRANSITIONS AUTORISÉES — la table fait foi, aucun `if` ne la double.
 *
 * Un état terminal n'a pas de sortie : rouvrir un événement classé
 * réécrirait l'histoire. Une correction se fait par un nouvel événement.
 */
export const EVENT_TRANSITIONS = Object.freeze({
  PLANNED: ['DUE', 'CANCELLED'],
  DUE: ['COMPLETED', 'MISSED', 'CANCELLED'],
  COMPLETED: [],
  MISSED: [],
  CANCELLED: [],
});

/** Motifs de non-tenue — fermés, pour rester agrégeables. */
export const MISSED_REASONS = Object.freeze([
  'CANCELLED', 'CLIENT_ABSENT', 'TEAM_ABSENT', 'OTHER',
]);

const participantSchema = new mongoose.Schema(
  {
    // Membre de l'équipe Panel : on garde l'e-mail, stable et lisible.
    email: { type: String, default: null },
    name: { type: String, default: null },
  },
  { _id: false },
);

const transitionSchema = new mongoose.Schema(
  {
    at: { type: String, required: true },
    from: { type: String, default: null },
    to: { type: String, required: true },
    /** `SYSTEM` pour le passage automatique à l'échéance : il n'a pas d'auteur. */
    actorEmail: { type: String, default: null },
    actorRole: { type: String, default: null },
    reason: { type: String, default: null },
  },
  { _id: false },
);

const eventSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, index: true },
    projectName: { type: String, default: null },

    type: { type: String, enum: EVENT_TYPES, default: 'MEETING' },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    scheduledAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 60, min: 0 },

    status: {
      type: String,
      enum: EVENT_STATUS_VALUES,
      default: EVENT_STATUS.PLANNED,
      index: true,
    },

    internalParticipants: { type: [participantSchema], default: [] },
    externalParticipants: { type: [String], default: [] },

    // Ce qui s'est réellement passé — renseigné à la confirmation, jamais avant.
    occurredAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    missedReason: { type: String, enum: [...MISSED_REASONS, null], default: null },
    notes: { type: String, default: '' },
    outcome: { type: String, default: '' },
    nextActions: { type: [String], default: [] },

    // REPORT — les deux sens du lien. Sans le retour, l'ancien événement
    // deviendrait un cul-de-sac dans l'historique.
    reportOfEventId: { type: String, default: null },
    rescheduledToEventId: { type: String, default: null },

    /**
     * Prochaine relance de la confirmation. « Me le rappeler plus tard » la
     * repousse ; sans cela, la boîte reviendrait à chaque rafraîchissement et
     * l'on apprendrait très vite à l'ignorer.
     */
    remindAfter: { type: Date, default: null },

    // Journal des transitions : qui, quand, d'où vers où, et pourquoi.
    transitions: { type: [transitionSchema], default: [] },

    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

// L'agenda se lit par date ; les confirmations en attente, par statut.
eventSchema.index({ scheduledAt: 1, status: 1 });
eventSchema.index({ status: 1, remindAfter: 1 });

export const PanelProjectEvent = mongoose.model('PanelProjectEvent', eventSchema);

export default PanelProjectEvent;
