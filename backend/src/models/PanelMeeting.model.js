import mongoose from 'mongoose';

/**
 * RÉUNION — un rendez-vous PRÉVU.
 *
 * ── POURQUOI C'EST UN OBJET À PART ──────────────────────────────────────────
 * Une réunion et un événement ne répondent pas à la même question. La réunion
 * dit « nous avons prévu de nous voir le 12 à 14 h » ; l'événement dit « le 12
 * à 14 h 10, voici ce qui s'est passé ». L'une se déplace, s'annule, se
 * reporte — elle appartient à l'agenda. L'autre ne bouge plus jamais : c'est
 * de l'histoire.
 *
 * Les confondre imposait un objet aux deux moitiés vides à tout instant : des
 * champs de compte rendu sur un rendez-vous qui n'a pas eu lieu, une date de
 * report sur un fait passé. Et surtout, cela rendait indicible le cas le plus
 * courant : une réunion prévue, tenue, dont le compte rendu diffère du plan.
 *
 * ── L'HEURE PASSÉE NE CLÔT RIEN ─────────────────────────────────────────────
 * À l'échéance, la réunion passe en DONE_PENDING_CONFIRMATION — « à
 * confirmer ». Elle n'est jamais déclarée tenue toute seule : seul un humain
 * sait si elle a eu lieu.
 */
export const MEETING_STATUS = Object.freeze({
  PLANNED: 'PLANNED',
  DONE_PENDING_CONFIRMATION: 'DONE_PENDING_CONFIRMATION',
  CANCELLED: 'CANCELLED',
  RESCHEDULED: 'RESCHEDULED',
});

export const MEETING_STATUS_VALUES = Object.freeze(Object.values(MEETING_STATUS));

/**
 * MODE — où et comment on se voit.
 *
 * Un seul champ « lieu » ne suffisait pas : une adresse, un numéro de
 * téléphone et un lien de visioconférence ne se saisissent pas, ne se valident
 * pas et ne s'affichent pas de la même façon. Les mélanger dans une chaîne
 * libre rendait impossible d'ouvrir la visio d'un clic ou d'appeler depuis un
 * mobile.
 */
export const MEETING_MODES = Object.freeze(['ONSITE', 'REMOTE']);
export const REMOTE_KINDS = Object.freeze(['CALL', 'VIDEO']);

/**
 * Transitions autorisées. Une réunion ne « redevient » jamais planifiée :
 * reporter crée une NOUVELLE réunion, l'ancienne reste dans l'histoire.
 */
export const MEETING_TRANSITIONS = Object.freeze({
  PLANNED: ['DONE_PENDING_CONFIRMATION', 'CANCELLED', 'RESCHEDULED'],
  DONE_PENDING_CONFIRMATION: ['CANCELLED', 'RESCHEDULED'],
  CANCELLED: [],
  RESCHEDULED: [],
});

const participantSchema = new mongoose.Schema(
  { email: { type: String, default: null }, name: { type: String, default: null } },
  { _id: false },
);

const changeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    from: { type: mongoose.Schema.Types.Mixed, default: null },
    to: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

export const revisionSchema = new mongoose.Schema(
  {
    at: { type: String, required: true },
    actorEmail: { type: String, default: null },
    actorRole: { type: String, default: null },
    reason: { type: String, default: null },
    changes: { type: [changeSchema], default: [] },
  },
  { _id: false },
);

const meetingSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, index: true },
    projectName: { type: String, default: null },

    title: { type: String, required: true, trim: true },
    /** Ordre du jour : ce qu'on prévoit d'aborder, pas ce qui a été dit. */
    description: { type: String, default: '' },

    scheduledAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 60, min: 0 },

    /**
     * PRÉSENTIEL ou DISTANCIEL, et les champs qui vont avec.
     *
     * Les champs incompatibles sont EFFACÉS au changement de mode, ils ne sont
     * pas seulement masqués : une adresse laissée sur une visioconférence
     * finit par être lue comme le lieu du rendez-vous.
     */
    mode: { type: String, enum: MEETING_MODES, default: 'ONSITE' },

    // Présentiel
    address: { type: String, default: '' },
    addressComplement: { type: String, default: '' },
    accessNotes: { type: String, default: '' },

    // Distanciel
    remoteKind: { type: String, enum: [...REMOTE_KINDS, null], default: null },
    phone: { type: String, default: '' },
    meetingUrl: { type: String, default: '' },

    status: {
      type: String,
      enum: MEETING_STATUS_VALUES,
      default: MEETING_STATUS.PLANNED,
      index: true,
    },

    internalParticipants: { type: [participantSchema], default: [] },
    externalParticipants: { type: [String], default: [] },

    // REPORT — les deux sens. Sans le retour, l'ancienne réunion serait un
    // cul-de-sac : on lirait « reportée » sans jamais savoir vers quand.
    rescheduledFromMeetingId: { type: String, default: null },
    rescheduledToMeetingId: { type: String, default: null },

    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },

    /**
     * HISTORIQUE DES CORRECTIONS.
     *
     * Une réunion reste modifiable, y compris passée : une erreur de saisie se
     * corrige. Mais corriger n'est pas effacer — chaque modification consigne
     * son auteur, sa date, les anciennes et les nouvelles valeurs, et son
     * motif éventuel. L'historique ne se réécrit pas, il s'allonge.
     */
    revisions: { type: [revisionSchema], default: [] },

    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

// L'agenda se lit par date ; l'échéancier, par statut et date.
meetingSchema.index({ status: 1, scheduledAt: 1 });

export const PanelMeeting = mongoose.model('PanelMeeting', meetingSchema);

export default PanelMeeting;
