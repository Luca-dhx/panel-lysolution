/**
 * AGENDA ET ÉVÉNEMENTS — le suivi client de l'équipe.
 *
 * ── TROIS SECTIONS, ET L'ORDRE COMPTE ───────────────────────────────────────
 * Ce qui attend une réponse d'abord — une confirmation se périme, un
 * rendez-vous à venir non. Puis l'agenda. Puis l'histoire.
 *
 * Réunions et événements ne sont JAMAIS mélangés dans une même liste : l'un
 * est un rendez-vous prévu qui peut encore se déplacer, l'autre un fait daté
 * qui ne bouge plus. Les confondre à l'écran, c'est demander à l'utilisateur
 * de faire le tri que le modèle a refusé de faire.
 *
 * Ces données appartiennent au Panel : aucun projet n'en reçoit copie.
 */
import { useState } from 'react';
import { Card, EmptyState } from '@/components/ui';
import { EventConfirmation } from '@/components/EventConfirmation';
import { EventRow, MeetingRow } from '@/components/EventLists';
import { MeetingForm, PastEventForm } from '@/components/EventForms';
import { useEvents, useMeetings, usePendingEvents } from '@/lib/useEvents';

type Volet = null | 'reunion' | 'evenement';

export function AgendaPage() {
  const [volet, setVolet] = useState<Volet>(null);

  const { meetings: aVenir, isInitialLoading, error, reload: rechargerReunions } = useMeetings('upcoming');
  const { events: enAttente, reload: rechargerAttente } = usePendingEvents();
  const { events: recents, reload: rechargerRecents } = useEvents({ all: true });

  const toutRecharger = () => {
    void rechargerReunions();
    void rechargerAttente();
    void rechargerRecents();
  };

  const historique = recents.filter((e) => e.status !== 'PENDING_CONFIRMATION').slice(0, 20);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Agenda et événements</h1>
        <p className="page-description">
          Les rendez-vous de l’équipe avec ses clients, et ce qui s’est réellement passé.
          Ces informations restent dans le Panel : aucun projet n’en reçoit copie.
        </p>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}

      <div className="contract-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={() => setVolet('reunion')}>
          Planifier une réunion
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => setVolet('evenement')}>
          Ajouter un événement passé
        </button>
      </div>

      {volet === 'reunion' ? (
        <MeetingForm
          onCreated={() => { setVolet(null); toutRecharger(); }}
          onCancel={() => setVolet(null)}
        />
      ) : null}
      {volet === 'evenement' ? (
        <PastEventForm
          onCreated={() => { setVolet(null); toutRecharger(); }}
          onCancel={() => setVolet(null)}
        />
      ) : null}

      {/* ── 1. Ce qui attend une réponse ──────────────────────────────────── */}
      {enAttente.length > 0 ? (
        <Card title={`Réunions à confirmer (${enAttente.length})`}>
          {enAttente.map((e) => (
            <EventConfirmation key={e._id} event={e} onResolved={toutRecharger} />
          ))}
        </Card>
      ) : null}

      {/* ── 2. L'agenda ───────────────────────────────────────────────────── */}
      <Card title="Réunions à venir">
        {isInitialLoading ? (
          <p className="muted">Chargement de l’agenda…</p>
        ) : aVenir.length === 0 ? (
          <EmptyState
            title="Aucune réunion prévue"
            hint="Planifiez un point avec l’un de vos clients."
          />
        ) : (
          <ul className="event-list">
            {aVenir.map((m) => <MeetingRow key={m._id} meeting={m} />)}
          </ul>
        )}
      </Card>

      {/* ── 3. L'histoire ─────────────────────────────────────────────────── */}
      <Card title="Événements récents">
        {historique.length === 0 ? (
          <p className="muted">Rien n’a encore été consigné.</p>
        ) : (
          <ul className="event-list">
            {historique.map((e) => <EventRow key={e._id} event={e} />)}
          </ul>
        )}
      </Card>
    </div>
  );
}
