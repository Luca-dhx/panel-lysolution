/** Vocabulaire des écrans — jamais un identifiant technique à l'affichage. */
import type { EventStatus, EventType, MeetingStatus } from '@/types.events';

export const TYPE_LABELS: Record<EventType, string> = {
  MEETING_OCCURRED: 'Réunion',
  CALL: 'Appel',
  VIDEO_CALL: 'Visioconférence',
  MEAL: 'Repas',
  FOLLOW_UP: 'Relance',
  OTHER: 'Autre',
};

type Tone = 'ok' | 'warn' | 'error' | 'neutral';

export function eventStatusState(status: EventStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'PENDING_CONFIRMATION': return { label: 'À confirmer', tone: 'warn' };
    case 'CONFIRMED': return { label: 'A eu lieu', tone: 'ok' };
    case 'MISSED': return { label: 'N’a pas eu lieu', tone: 'error' };
    case 'CANCELLED': return { label: 'Annulé', tone: 'neutral' };
    default: return { label: 'Inconnu', tone: 'neutral' };
  }
}

export function meetingStatusState(status: MeetingStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'PLANNED': return { label: 'Prévue', tone: 'neutral' };
    case 'DONE_PENDING_CONFIRMATION': return { label: 'À confirmer', tone: 'warn' };
    case 'CANCELLED': return { label: 'Annulée', tone: 'neutral' };
    case 'RESCHEDULED': return { label: 'Reportée', tone: 'neutral' };
    default: return { label: 'Inconnue', tone: 'neutral' };
  }
}
