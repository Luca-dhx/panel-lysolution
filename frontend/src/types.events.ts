/**
 * Agenda et historique — données PROPRES au Panel.
 *
 * Deux objets distincts, et la distinction n'est pas cosmétique : une réunion
 * se déplace, s'annule, se reporte — elle vit dans l'agenda. Un événement est
 * daté au passé et ne bouge plus — c'est de l'histoire.
 */

export type MeetingMode = 'ONSITE' | 'REMOTE';
export type RemoteKind = 'CALL' | 'VIDEO';

export interface Revision {
  at: string;
  actorEmail: string | null;
  actorRole: string | null;
  reason: string | null;
  changes: { field: string; from: unknown; to: unknown }[];
}

export type MeetingStatus = 'PLANNED' | 'DONE_PENDING_CONFIRMATION' | 'CANCELLED' | 'RESCHEDULED';
export type MeetingScope = 'upcoming' | 'today' | 'to_confirm' | 'past';

export type EventType = 'MEETING_OCCURRED' | 'CALL' | 'VIDEO_CALL' | 'MEAL' | 'FOLLOW_UP' | 'OTHER';
export type EventStatus = 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'MISSED' | 'CANCELLED';
export type MissedReason = 'CANCELLED' | 'CLIENT_ABSENT' | 'TEAM_ABSENT' | 'OTHER';

/**
 * PARTICIPANTS — une liste de personnes, jamais un texte à virgules.
 *
 * `id` rend chaque participant modifiable et supprimable seul ; `type` remplace
 * les deux anciennes listes (internes / externes), parce qu'être interne ou
 * externe est une propriété de la personne, pas deux tableaux à tenir.
 */
export type ParticipantType = 'INTERNAL' | 'EXTERNAL';

export interface Participant {
  id: string;
  type: ParticipantType;
  name: string;
  email?: string;
  phone?: string;
}

export interface Meeting {
  _id: string;
  projectId: string;
  projectName: string | null;
  title: string;
  description: string;
  scheduledAt: string;
  durationMinutes: number;
  mode: MeetingMode;
  address: string;
  addressComplement: string;
  accessNotes: string;
  remoteKind: RemoteKind | null;
  phone: string;
  meetingUrl: string;
  status: MeetingStatus;
  participants: Participant[];
  rescheduledFromMeetingId: string | null;
  rescheduledToMeetingId: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  revisions: Revision[];
  createdBy: string | null;
  createdAt: string;
}

export interface ProjectEvent {
  _id: string;
  projectId: string;
  projectName: string | null;
  sourceMeetingId: string | null;
  type: EventType;
  title: string;
  occurredAt: string;
  status: EventStatus;
  participants: Participant[];
  notes: string;
  outcome: string;
  nextActions: string[];
  missedReason: MissedReason | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  revisions: Revision[];
  createdBy: string | null;
  createdAt: string;
}

export interface ProjectEventsSummary {
  pending: ProjectEvent[];
  history: ProjectEvent[];
}
