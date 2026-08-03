/**
 * AGENDA ET ÉVÉNEMENTS — le suivi client de l'équipe.
 *
 * Une page, pas deux. « Agenda » et « Événements » auraient montré les mêmes
 * objets sous deux angles, avec deux endroits où corriger le même bogue. Les
 * filtres suffisent à passer de l'un à l'autre.
 *
 * Ces données appartiennent au Panel : aucun projet n'en reçoit copie.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState } from '@/components/ui';
import { EventConfirmation } from '@/components/EventConfirmation';
import { EventForm } from '@/components/EventForm';
import { useEvents } from '@/lib/useEvents';
import { formatDateTime } from '@/lib/format';
import { toneBadgeClass } from '@/lib/projectPresentation';
import type { EventScope, ProjectEvent } from '@/types.events';

const FILTRES: { scope: EventScope; label: string }[] = [
  { scope: 'today', label: 'Aujourd’hui' },
  { scope: 'upcoming', label: 'À venir' },
  { scope: 'to_confirm', label: 'À confirmer' },
  { scope: 'past', label: 'Passés' },
];

export const TYPE_LABELS: Record<string, string> = {
  MEETING: 'Réunion',
  CALL: 'Appel',
  VIDEO_CALL: 'Visio',
  MEAL: 'Repas',
  FOLLOW_UP: 'Relance',
  OTHER: 'Autre',
};

export function eventStatusState(status: string): { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral' } {
  switch (status) {
    case 'PLANNED': return { label: 'Planifié', tone: 'neutral' };
    case 'DUE': return { label: 'À confirmer', tone: 'warn' };
    case 'COMPLETED': return { label: 'A eu lieu', tone: 'ok' };
    case 'MISSED': return { label: 'N’a pas eu lieu', tone: 'error' };
    case 'CANCELLED': return { label: 'Annulé', tone: 'neutral' };
    default: return { label: status, tone: 'neutral' };
  }
}

export function EventRow({ event }: { event: ProjectEvent }) {
  const etat = eventStatusState(event.status);
  return (
    <li className="event-row">
      <span className="event-row-when">{formatDateTime(event.scheduledAt)}</span>
      <span className="event-row-main">
        <span className="event-row-title">{event.title}</span>
        <span className="muted">
          {TYPE_LABELS[event.type] ?? event.type}
          {event.projectName ? ` · ${event.projectName}` : ''}
          {event.durationMinutes ? ` · ${event.durationMinutes} min` : ''}
        </span>
        {event.outcome ? <span className="muted">{event.outcome}</span> : null}
      </span>
      <span className={toneBadgeClass(etat.tone)}>{etat.label}</span>
      <Link className="btn btn-secondary btn-small" to={`/projects/${event.projectId}`}>
        Voir le projet
      </Link>
    </li>
  );
}

export function AgendaPage() {
  const [scope, setScope] = useState<EventScope>('upcoming');
  const [ouvert, setOuvert] = useState(false);
  const { events, isInitialLoading, error, reload } = useEvents(scope);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Agenda et événements</h1>
        <p className="page-description">
          Les rendez-vous de l’équipe avec ses clients. Ces informations restent dans le Panel :
          aucun projet n’en reçoit copie.
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      <div className="contract-actions">
        {FILTRES.map((f) => (
          <button
            key={f.scope}
            type="button"
            className={scope === f.scope ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small'}
            onClick={() => setScope(f.scope)}
          >
            {f.label}
          </button>
        ))}
        <button type="button" className="btn btn-primary btn-small" onClick={() => setOuvert(true)}>
          Planifier un événement
        </button>
      </div>

      {ouvert ? (
        <EventForm
          onCreated={() => { setOuvert(false); void reload(); }}
          onCancel={() => setOuvert(false)}
        />
      ) : null}

      {/* Les confirmations en attente passent en tête : c'est ce qui se périme. */}
      {scope === 'to_confirm'
        ? events.map((e) => (
          <EventConfirmation key={e._id} event={e} onResolved={() => void reload()} />
        ))
        : null}

      {isInitialLoading ? (
        <p className="muted">Chargement de l’agenda…</p>
      ) : events.length === 0 ? (
        <EmptyState
          title="Aucun événement"
          hint="Planifiez une réunion, un appel ou une relance pour l’un de vos projets."
        />
      ) : scope !== 'to_confirm' ? (
        <Card>
          <ul className="event-list">
            {events.map((e) => <EventRow key={e._id} event={e} />)}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
