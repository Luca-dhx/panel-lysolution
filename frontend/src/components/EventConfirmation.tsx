/**
 * BOÎTE DE CONFIRMATION — « cette réunion a-t-elle eu lieu ? »
 *
 * ── POURQUOI ELLE EXISTE ────────────────────────────────────────────────────
 * Le temps ne confirme rien. Un rendez-vous dont l'heure est passée est « à
 * confirmer », pas « tenu ». Sans cette question, l'historique se remplirait
 * de réunions qui n'ont jamais eu lieu — et deviendrait inutilisable
 * exactement le jour où l'on en aurait besoin.
 *
 * ── QUATRE RÉPONSES, PAS DEUX ───────────────────────────────────────────────
 * « Oui » et « non » ne suffisent pas : une réunion se reporte aussi, et l'on
 * n'a pas toujours le temps d'écrire un compte rendu tout de suite. « Plus
 * tard » est donc une réponse légitime — elle laisse l'événement dû et recule
 * la relance de deux heures, au lieu de faire réapparaître la même boîte à
 * chaque rafraîchissement.
 */
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { MissedReason, ProjectEvent } from '@/types.events';

const MOTIFS: { value: MissedReason; label: string }[] = [
  { value: 'CANCELLED', label: 'Annulée' },
  { value: 'CLIENT_ABSENT', label: 'Client absent' },
  { value: 'TEAM_ABSENT', label: 'Équipe absente' },
  { value: 'OTHER', label: 'Autre motif' },
];

const heure = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

type Volet = null | 'oui' | 'non' | 'reporter';

export function EventConfirmation({
  event,
  onResolved,
}: {
  event: ProjectEvent;
  onResolved: () => void;
}) {
  const [volet, setVolet] = useState<Volet>(null);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState('');
  const [actions, setActions] = useState('');
  const [heureReelle, setHeureReelle] = useState('');
  const [participants, setParticipants] = useState(event.externalParticipants.join(', '));
  const [motif, setMotif] = useState<MissedReason>('CLIENT_ABSENT');
  const [nouvelleDate, setNouvelleDate] = useState('');

  const agir = async (action: () => Promise<unknown>) => {
    setErreur(null);
    setEnCours(true);
    try {
      await action();
      onResolved();
    } catch (err) {
      setErreur(errorMessage(err, 'L’action n’a pas abouti.'));
    } finally {
      setEnCours(false);
    }
  };

  const quoi = event.type === 'MEETING' ? 'La réunion' : 'L’événement';
  const avecQui = event.projectName || 'ce projet';

  return (
    <div className="alert alert-warning event-confirm">
      <p>
        <strong>{quoi} avec {avecQui}</strong> était prévu{event.type === 'MEETING' ? 'e' : ''} le{' '}
        {formatDateTime(event.scheduledAt)} à {heure(event.scheduledAt)}.
        <br />
        A-t-{event.type === 'MEETING' ? 'elle' : 'il'} bien eu lieu ?
      </p>
      <p className="muted">{event.title}</p>

      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      {volet === null ? (
        <div className="contract-actions">
          <button type="button" className="btn btn-primary btn-small" onClick={() => setVolet('oui')}>
            Oui, {event.type === 'MEETING' ? 'elle' : 'il'} a eu lieu
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setVolet('non')}>
            Non, {event.type === 'MEETING' ? 'elle' : 'il'} n’a pas eu lieu
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setVolet('reporter')}>
            Reporter
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={enCours}
            onClick={() => void agir(() => api.snoozeEvent(event._id))}
          >
            Me le rappeler plus tard
          </button>
        </div>
      ) : null}

      {volet === 'oui' ? (
        <div className="event-form">
          <label className="field">
            <span className="field-label">Compte rendu</span>
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Ce qui en ressort</span>
            <input type="text" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Prochaines actions (une par ligne)</span>
            <textarea rows={2} value={actions} onChange={(e) => setActions(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Participants</span>
            <input
              type="text"
              value={participants}
              onChange={(e) => setParticipants(e.target.value)}
              placeholder="séparés par des virgules"
            />
          </label>
          <label className="field">
            <span className="field-label">Heure réelle, si différente</span>
            <input
              type="datetime-local"
              value={heureReelle}
              onChange={(e) => setHeureReelle(e.target.value)}
            />
          </label>
          <div className="contract-actions">
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={enCours}
              onClick={() => void agir(() => api.completeEvent(event._id, {
                notes,
                outcome,
                nextActions: actions.split('\n').map((a) => a.trim()).filter(Boolean),
                externalParticipants: participants.split(',').map((p) => p.trim()).filter(Boolean),
                ...(heureReelle ? { occurredAt: new Date(heureReelle).toISOString() } : {}),
              }))}
            >
              {enCours ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setVolet(null)}>
              Retour
            </button>
          </div>
        </div>
      ) : null}

      {volet === 'non' ? (
        <div className="event-form">
          <label className="field">
            <span className="field-label">Que s’est-il passé ?</span>
            <select value={motif} onChange={(e) => setMotif(e.target.value as MissedReason)}>
              {MOTIFS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Précision (facultative)</span>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <p className="muted">
            « Annulée » est une décision, les autres motifs sont des constats : l’historique les
            distingue.
          </p>
          <div className="contract-actions">
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={enCours}
              onClick={() => void agir(() => api.missEvent(event._id, { reason: motif, notes }))}
            >
              {enCours ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setVolet(null)}>
              Retour
            </button>
          </div>
        </div>
      ) : null}

      {volet === 'reporter' ? (
        <div className="event-form">
          <label className="field">
            <span className="field-label">Nouvelle date</span>
            <input
              type="datetime-local"
              value={nouvelleDate}
              onChange={(e) => setNouvelleDate(e.target.value)}
            />
          </label>
          <p className="muted">
            L’événement d’origine est clos et relié au nouveau : l’historique garde la trace des
            deux dates.
          </p>
          <div className="contract-actions">
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={enCours || !nouvelleDate}
              onClick={() => void agir(() => api.rescheduleEvent(event._id, {
                scheduledAt: new Date(nouvelleDate).toISOString(),
                reason: 'Reporté',
              }))}
            >
              {enCours ? 'Report…' : 'Reporter'}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setVolet(null)}>
              Retour
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
