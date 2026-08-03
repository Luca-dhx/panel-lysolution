/** Agenda et événements de suivi — données PROPRES au Panel. */

export type EventType = 'MEETING' | 'CALL' | 'VIDEO_CALL' | 'MEAL' | 'FOLLOW_UP' | 'OTHER';
export type EventStatus = 'PLANNED' | 'DUE' | 'COMPLETED' | 'MISSED' | 'CANCELLED';
export type MissedReason = 'CANCELLED' | 'CLIENT_ABSENT' | 'TEAM_ABSENT' | 'OTHER';
export type EventScope = 'today' | 'upcoming' | 'to_confirm' | 'past';

export interface EventTransition {
  at: string;
  from: string | null;
  to: string;
  actorEmail: string | null;
  actorRole: string | null;
  reason: string | null;
}

export interface ProjectEvent {
  _id: string;
  projectId: string;
  projectName: string | null;
  type: EventType;
  title: string;
  description: string;
  scheduledAt: string;
  durationMinutes: number;
  status: EventStatus;
  internalParticipants: { email: string | null; name: string | null }[];
  externalParticipants: string[];
  occurredAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  missedReason: MissedReason | null;
  notes: string;
  outcome: string;
  nextActions: string[];
  reportOfEventId: string | null;
  rescheduledToEventId: string | null;
  remindAfter: string | null;
  transitions: EventTransition[];
  createdBy: string | null;
  createdAt: string;
}

export interface ProjectEventsSummary {
  next: ProjectEvent | null;
  toConfirm: ProjectEvent[];
  history: ProjectEvent[];
}
