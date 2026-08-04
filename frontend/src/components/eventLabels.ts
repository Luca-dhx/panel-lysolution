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

/**
 * IMMINENCE D'UNE RÉUNION — « Demain », « Dans 20 min », « Maintenant ».
 *
 * ── POURQUOI UNE FONCTION, ET UNE SEULE ─────────────────────────────────────
 * « Prévue » ne dit rien de l'urgence : une réunion dans trois mois et une
 * réunion dans dix minutes portaient la même pastille grise. C'est le genre de
 * détail qui fait rater un rendez-vous alors qu'il était à l'écran.
 *
 * ── « DEMAIN » EST UNE DATE, PAS UN NOMBRE D'HEURES ─────────────────────────
 * Compter 24 heures se trompe deux fois par jour : une réunion à 23 h ce soir
 * serait « demain », et une réunion à 9 h demain matin, vue à 8 h, ne le serait
 * pas. On compare donc les dates CIVILES, dans le fuseau du navigateur — celui
 * que le Panel utilise déjà partout pour afficher ses heures.
 *
 * Fonction PURE : `maintenant` est un paramètre. Aucune carte ne pose de
 * minuteur — la lecture vivante de l'agenda rafraîchit déjà l'écran, et un
 * intervalle par carte multiplierait les réveils pour rien.
 */
export function meetingImminence(
  scheduledAt: string,
  status: MeetingStatus,
  maintenant: Date = new Date(),
): { label: string; tone: Tone; imminent: boolean } {
  const neutre = meetingStatusState(status);
  // Seule une réunion encore PRÉVUE peut être imminente : une réunion annulée,
  // reportée ou déjà passée garde son état, qui est plus informatif.
  if (status !== 'PLANNED') return { ...neutre, imminent: false };

  const debut = new Date(scheduledAt);
  if (Number.isNaN(debut.getTime())) return { ...neutre, imminent: false };

  const jour = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const joursDEcart = Math.round((jour(debut) - jour(maintenant)) / 86_400_000);
  const minutes = Math.round((debut.getTime() - maintenant.getTime()) / 60_000);

  // L'heure est atteinte, mais l'ordonnanceur n'a pas encore basculé l'état :
  // dire « dans 0 min » serait faux, et « prévue » trompeur.
  if (minutes <= 0) return { label: 'Maintenant', tone: 'warn', imminent: true };

  if (joursDEcart === 0) {
    if (minutes < 60) {
      return {
        label: minutes <= 15 ? `Dans ${minutes} min` : 'Dans moins d’une heure',
        tone: 'warn',
        imminent: true,
      };
    }
    const heures = Math.round(minutes / 60);
    return { label: `Dans ${heures} h`, tone: 'warn', imminent: true };
  }

  if (joursDEcart === 1) return { label: 'Demain', tone: 'warn', imminent: true };

  return { ...neutre, imminent: false };
}
