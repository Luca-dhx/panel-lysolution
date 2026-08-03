/** Lignes d'agenda et d'historique — deux formes, parce que deux natures. */
import { Link } from 'react-router-dom';
import { formatDateTime } from '@/lib/format';
import { toneBadgeClass } from '@/lib/projectPresentation';
import { TYPE_LABELS, eventStatusState, meetingStatusState } from '@/components/eventLabels';
import type { Meeting, ProjectEvent } from '@/types.events';

/**
 * Où et comment on se voit, en une phrase.
 *
 * On affiche l'intention, pas la donnée brute : « Visioconférence » plutôt
 * qu'une URL de quatre-vingts caractères qui déborde de la ligne. Le lien reste
 * cliquable dans le détail de la réunion.
 */
function lieuLisible(m: Meeting): string {
  if (m.mode === 'REMOTE') return m.remoteKind === 'CALL' ? `Appel ${m.phone}`.trim() : 'Visioconférence';
  return m.address || 'Présentiel';
}

/** Une réunion : ce qui est PRÉVU. On montre l'heure, la durée, le lieu. */
export function MeetingRow({
  meeting,
  showProject = true,
  onEdit,
  onCancel,
}: {
  meeting: Meeting;
  showProject?: boolean;
  onEdit?: (m: Meeting) => void;
  onCancel?: (m: Meeting) => void;
}) {
  const etat = meetingStatusState(meeting.status);
  const modifiable = meeting.status === 'PLANNED' || meeting.status === 'DONE_PENDING_CONFIRMATION';
  return (
    <li className="event-row">
      <span className="event-row-when">{formatDateTime(meeting.scheduledAt)}</span>
      <span className="event-row-main">
        <span className="event-row-title">{meeting.title}</span>
        <span className="muted">
          {showProject && meeting.projectName ? `${meeting.projectName} · ` : ''}
          {meeting.durationMinutes ? `${meeting.durationMinutes} min` : ''}
          {` · ${lieuLisible(meeting)}`}
        </span>
      </span>
      <span className={toneBadgeClass(etat.tone)}>{etat.label}</span>
      {onEdit ? (
        <button type="button" className="btn btn-secondary btn-small" onClick={() => onEdit(meeting)}>
          Modifier
        </button>
      ) : null}
      {onCancel && modifiable ? (
        <button type="button" className="btn btn-secondary btn-small" onClick={() => onCancel(meeting)}>
          Annuler
        </button>
      ) : null}
      {showProject ? (
        <Link className="btn btn-secondary btn-small" to={`/projects/${meeting.projectId}`}>
          Voir le projet
        </Link>
      ) : null}
    </li>
  );
}

/** Un événement : ce qui S'EST PASSÉ. On montre la date réelle et le résultat. */
export function EventRow({
  event,
  showProject = true,
  onEdit,
}: {
  event: ProjectEvent;
  showProject?: boolean;
  onEdit?: (e: ProjectEvent) => void;
}) {
  const etat = eventStatusState(event.status);
  return (
    <li className="event-row">
      <span className="event-row-when">{formatDateTime(event.occurredAt)}</span>
      <span className="event-row-main">
        <span className="event-row-title">{event.title}</span>
        <span className="muted">
          {TYPE_LABELS[event.type]}
          {showProject && event.projectName ? ` · ${event.projectName}` : ''}
        </span>
        {event.outcome ? <span className="muted">{event.outcome}</span> : null}
      </span>
      <span className={toneBadgeClass(etat.tone)}>{etat.label}</span>
      {onEdit ? (
        <button type="button" className="btn btn-secondary btn-small" onClick={() => onEdit(event)}>
          Modifier
        </button>
      ) : null}
      {showProject ? (
        <Link className="btn btn-secondary btn-small" to={`/projects/${event.projectId}`}>
          Voir le projet
        </Link>
      ) : null}
    </li>
  );
}
