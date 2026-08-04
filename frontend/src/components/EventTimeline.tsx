/**
 * TIMELINE DES ÉVÉNEMENTS — l'histoire d'un client, compacte puis dépliable.
 *
 * ── CE QUI EXISTAIT ─────────────────────────────────────────────────────────
 * Une liste de lignes toutes ouvertes, où le compte rendu, le résultat et les
 * participants s'affichaient en permanence. Trois événements bavards
 * remplissaient l'écran, et la CHRONOLOGIE — la seule chose qu'on vient
 * chercher dans un historique — disparaissait sous le texte. Les notes
 * internes, en particulier, restaient exposées en continu alors qu'on ne les
 * lit qu'à dessein.
 *
 * ── CE QUE C'EST DEVENU ─────────────────────────────────────────────────────
 * Une ligne verticale, un repère par événement. Chaque entrée tient sur deux
 * lignes : ce que c'était, quand, dans quel état. Le reste — compte rendu,
 * participants, résultat, motif d'absence, corrections successives — s'ouvre
 * au clic, une entrée à la fois.
 *
 * Le détail est rendu SOUS l'entrée, pas dans une fenêtre : un historique se
 * parcourt, et une modale par événement obligerait à ouvrir puis refermer pour
 * comparer deux dates. L'ouverture est animée, brièvement, et la durée vient du
 * thème — donc nulle pour qui a demandé moins d'animations.
 */
import { useState } from 'react';
import { formatDateTime } from '@/lib/format';
import { toneBadgeClass } from '@/lib/projectPresentation';
import { TYPE_LABELS, eventStatusState } from '@/components/eventLabels';
import { ParticipantsSummary } from '@/components/Participants';
import { Icon } from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import type { EventType, ProjectEvent, Revision } from '@/types.events';

/** Le type d'un événement se reconnaît à son icône avant d'être lu. */
const ICONES: Record<EventType, IconName> = {
  MEETING_OCCURRED: 'people',
  CALL: 'telephone',
  VIDEO_CALL: 'camera-video',
  MEAL: 'building',
  FOLLOW_UP: 'envelope',
  OTHER: 'calendar-event',
};

const MOTIFS: Record<string, string> = {
  CANCELLED: 'Annulée',
  CLIENT_ABSENT: 'Client absent',
  TEAM_ABSENT: 'Équipe absente',
  OTHER: 'Autre motif',
};

/** Une correction, dite en français : qui, quand, quoi, pourquoi. */
function Correction({ revision }: { revision: Revision }) {
  return (
    <li className="timeline-revision">
      <span className="muted">
        {formatDateTime(revision.at)}
        {revision.actorEmail ? ` · ${revision.actorEmail}` : ''}
        {revision.reason ? ` · ${revision.reason}` : ''}
      </span>
      <ul>
        {revision.changes.map((change) => (
          <li key={`${change.field}-${String(change.to)}`}>
            <strong>{change.field}</strong>{' : '}
            <span className="muted">{String(change.from ?? '—')}</span>
            {' → '}
            <span>{String(change.to ?? '—')}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function Entree({
  event,
  ouvert,
  onToggle,
}: {
  event: ProjectEvent;
  ouvert: boolean;
  onToggle: () => void;
}) {
  const etat = eventStatusState(event.status);
  const detailId = `timeline-detail-${event._id}`;
  // Ce qui tient sur une ligne : le résultat s'il existe, sinon la première
  // ligne du compte rendu. Les notes internes complètes restent fermées.
  const resume = event.outcome
    || (event.notes ? event.notes.split(/\r?\n/)[0] : '');

  return (
    <li className={ouvert ? 'timeline-item timeline-item-open' : 'timeline-item'}>
      <span className="timeline-mark" aria-hidden="true">
        <Icon name={ICONES[event.type] ?? 'calendar-event'} size={14} />
      </span>

      <button
        type="button"
        className="timeline-entry"
        aria-expanded={ouvert}
        aria-controls={detailId}
        onClick={onToggle}
      >
        <span className="timeline-entry-main">
          <span className="timeline-title">{event.title}</span>
          <span className="timeline-meta">
            <span className="muted">{TYPE_LABELS[event.type]}</span>
            <span className="muted">{formatDateTime(event.occurredAt)}</span>
            {event.confirmedBy ? <span className="muted">{event.confirmedBy}</span> : null}
          </span>
          {resume && !ouvert ? <span className="timeline-resume">{resume}</span> : null}
        </span>
        <span className={toneBadgeClass(etat.tone)}>{etat.label}</span>
        <Icon name="chevron-down" size={14} className="timeline-chevron" />
      </button>

      {ouvert ? (
        <div className="timeline-detail" id={detailId}>
          {event.notes ? (
            <div className="timeline-block">
              <span className="timeline-block-label">Compte rendu</span>
              <p>{event.notes}</p>
            </div>
          ) : null}

          {event.outcome ? (
            <div className="timeline-block">
              <span className="timeline-block-label">Ce qui en est ressorti</span>
              <p>{event.outcome}</p>
            </div>
          ) : null}

          {event.nextActions.length > 0 ? (
            <div className="timeline-block">
              <span className="timeline-block-label">Prochaines actions</span>
              <ul>
                {event.nextActions.map((action) => <li key={action}>{action}</li>)}
              </ul>
            </div>
          ) : null}

          {event.participants.length > 0 ? (
            <div className="timeline-block">
              <span className="timeline-block-label">Participants</span>
              <ParticipantsSummary participants={event.participants} />
            </div>
          ) : null}

          {event.missedReason ? (
            <div className="timeline-block">
              <span className="timeline-block-label">Pourquoi cela n’a pas eu lieu</span>
              <p>{MOTIFS[event.missedReason] ?? event.missedReason}</p>
            </div>
          ) : null}

          {event.sourceMeetingId ? (
            <p className="muted">Cet événement vient d’une réunion planifiée.</p>
          ) : null}

          {event.revisions.length > 0 ? (
            <div className="timeline-block">
              <span className="timeline-block-label">
                Corrections ({event.revisions.length})
              </span>
              <ul className="timeline-revisions">
                {event.revisions.map((revision) => (
                  <Correction key={revision.at} revision={revision} />
                ))}
              </ul>
            </div>
          ) : null}

          {!event.notes && !event.outcome && event.participants.length === 0
            && event.nextActions.length === 0 && event.revisions.length === 0 ? (
              <p className="muted">Rien d’autre n’a été consigné.</p>
            ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * @param events les événements DU projet courant — la liste est filtrée par
 *   l'appelant, qui seul sait de quel projet il parle.
 */
export function EventTimeline({
  events,
  onEdit,
}: {
  events: ProjectEvent[];
  onEdit?: (e: ProjectEvent) => void;
}) {
  // Une seule entrée ouverte : deux détails ouverts, et la chronologie
  // redevient la liste de blocs qu'on vient de quitter.
  const [ouvert, setOuvert] = useState<string | null>(null);

  return (
    <ol className="timeline">
      {events.map((event) => (
        <Entree
          key={event._id}
          event={event}
          ouvert={ouvert === event._id}
          onToggle={() => setOuvert((actuel) => (actuel === event._id ? null : event._id))}
        />
      ))}
      {onEdit && ouvert ? (
        <li className="timeline-actions">
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => {
              const event = events.find((e) => e._id === ouvert);
              if (event) onEdit(event);
            }}
          >
            Modifier cet événement
          </button>
        </li>
      ) : null}
    </ol>
  );
}

export default EventTimeline;
