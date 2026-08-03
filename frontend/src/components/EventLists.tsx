/** Lignes d'agenda et d'historique — deux formes, parce que deux natures. */
import { Link } from 'react-router-dom';
import { formatDateTime } from '@/lib/format';
import { toneBadgeClass } from '@/lib/projectPresentation';
import { TYPE_LABELS, eventStatusState, meetingStatusState } from '@/components/eventLabels';
import type { Meeting, ProjectEvent } from '@/types.events';

/** Une réunion : ce qui est PRÉVU. On montre l'heure, la durée, le lieu. */
export function MeetingRow({ meeting, showProject = true }: { meeting: Meeting; showProject?: boolean }) {
  const etat = meetingStatusState(meeting.status);
  return (
    <li className="event-row">
      <span className="event-row-when">{formatDateTime(meeting.scheduledAt)}</span>
      <span className="event-row-main">
        <span className="event-row-title">{meeting.title}</span>
        <span className="muted">
          {showProject && meeting.projectName ? `${meeting.projectName} · ` : ''}
          {meeting.durationMinutes ? `${meeting.durationMinutes} min` : ''}
          {meeting.location ? ` · ${meeting.location}` : ''}
        </span>
      </span>
      <span className={toneBadgeClass(etat.tone)}>{etat.label}</span>
      {showProject ? (
        <Link className="btn btn-secondary btn-small" to={`/projects/${meeting.projectId}`}>
          Voir le projet
        </Link>
      ) : null}
    </li>
  );
}

/** Un événement : ce qui S'EST PASSÉ. On montre la date réelle et le résultat. */
export function EventRow({ event, showProject = true }: { event: ProjectEvent; showProject?: boolean }) {
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
      {showProject ? (
        <Link className="btn btn-secondary btn-small" to={`/projects/${event.projectId}`}>
          Voir le projet
        </Link>
      ) : null}
    </li>
  );
}
