import mongoose from 'mongoose';

/**
 * ÉVÉNEMENT — ce qui S'EST PASSÉ avec un client.
 *
 * ── UN OBJET D'HISTOIRE, PAS D'AGENDA ───────────────────────────────────────
 * Un événement est daté au passé et ne se déplace plus. Il ne se reporte pas,
 * ne s'annule pas au sens d'un rendez-vous : on constate qu'il a eu lieu, ou
 * qu'il n'a pas eu lieu, et on écrit pourquoi.
 *
 * C'est pour cela que `MEETING` n'est pas un type d'événement : une réunion
 * est un objet d'AGENDA (`PanelMeeting`). Ce qu'un événement peut porter,
 * c'est `MEETING_OCCURRED` — le fait qu'une réunion prévue s'est tenue. La
 * nuance n'est pas de vocabulaire : l'un se déplace, l'autre jamais.
 *
 * ── LIEN AVEC LA RÉUNION ────────────────────────────────────────────────────
 * `sourceMeetingId` relie l'événement à la réunion qui l'a engendré. Il est
 * `null` pour un événement saisi à la main — un appel, un déjeuner, une
 * relance : ces choses arrivent sans avoir été planifiées, et l'historique
 * doit pouvoir les accueillir.
 */
export const EVENT_TYPES = Object.freeze([
  'MEETING_OCCURRED', 'CALL', 'VIDEO_CALL', 'MEAL', 'FOLLOW_UP', 'OTHER',
]);

export const EVENT_STATUS = Object.freeze({
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  CONFIRMED: 'CONFIRMED',
  MISSED: 'MISSED',
  CANCELLED: 'CANCELLED',
});

export const EVENT_STATUS_VALUES = Object.freeze(Object.values(EVENT_STATUS));

/**
 * Transitions autorisées. Les états de constat sont TERMINAUX : rouvrir un
 * fait consigné réécrirait l'histoire. Une correction se fait par un nouvel
 * événement, qui porte sa propre date de saisie.
 */
export const EVENT_TRANSITIONS = Object.freeze({
  PENDING_CONFIRMATION: ['CONFIRMED', 'MISSED', 'CANCELLED'],
  CONFIRMED: [],
  MISSED: [],
  CANCELLED: [],
});

/** Motifs de non-tenue — fermés, pour rester agrégeables. */
export const MISSED_REASONS = Object.freeze([
  'CANCELLED', 'CLIENT_ABSENT', 'TEAM_ABSENT', 'OTHER',
]);

const participantSchema = new mongoose.Schema(
  { email: { type: String, default: null }, name: { type: String, default: null } },
  { _id: false },
);

const eventSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, index: true },
    projectName: { type: String, default: null },

    /** La réunion d'origine, ou `null` pour un événement saisi à la main. */
    sourceMeetingId: { type: String, default: null },

    type: { type: String, enum: EVENT_TYPES, default: 'OTHER' },
    title: { type: String, required: true, trim: true },

    /** Quand cela s'est passé. Pour une réunion tenue, l'heure RÉELLE. */
    occurredAt: { type: Date, required: true, index: true },

    status: {
      type: String,
      enum: EVENT_STATUS_VALUES,
      default: EVENT_STATUS.PENDING_CONFIRMATION,
      index: true,
    },

    internalParticipants: { type: [participantSchema], default: [] },
    externalParticipants: { type: [String], default: [] },

    notes: { type: String, default: '' },
    outcome: { type: String, default: '' },
    nextActions: { type: [String], default: [] },
    missedReason: { type: String, enum: [...MISSED_REASONS, null], default: null },

    confirmedBy: { type: String, default: null },
    confirmedAt: { type: Date, default: null },

    /**
     * Prochaine relance de la confirmation. « Me le rappeler plus tard » la
     * repousse ; sans cela, la même question reviendrait à chaque
     * rafraîchissement et l'on apprendrait très vite à l'ignorer.
     */
    remindAfter: { type: Date, default: null },

    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

// L'historique se lit à l'envers ; les confirmations, par statut et relance.
eventSchema.index({ projectId: 1, occurredAt: -1 });
eventSchema.index({ status: 1, remindAfter: 1 });
// UNE seule confirmation par réunion : c'est cet index qui rend la conversion
// à l'échéance idempotente, quoi qu'il arrive du côté de l'ordonnanceur.
eventSchema.index(
  { sourceMeetingId: 1 },
  { unique: true, partialFilterExpression: { sourceMeetingId: { $type: 'string' } } },
);

export const PanelProjectEvent = mongoose.model('PanelProjectEvent', eventSchema);

export default PanelProjectEvent;
