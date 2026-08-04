/**
 * BOÎTE DE CONFIRMATION — « cette réunion a-t-elle eu lieu ? »
 *
 * ── POURQUOI ELLE EXISTE ────────────────────────────────────────────────────
 * Le temps ne confirme rien. Une réunion dont l'heure est passée est « à
 * confirmer », pas « tenue ». Sans cette question, l'historique se remplirait
 * de rendez-vous qui n'ont jamais eu lieu — et deviendrait inutilisable
 * exactement le jour où l'on en aurait besoin.
 *
 * ── TROIS RÉPONSES ──────────────────────────────────────────────────────────
 * Oui, non, ou reporter. « Me le rappeler plus tard » a été retiré : une
 * question qu'on peut repousser indéfiniment finit par n'être jamais posée, et
 * la liste des confirmations en attente devenait une file d'attente qu'on
 * apprend à ignorer. Répondre prend cinq secondes ; reporter la question ne
 * fait que la déplacer.
 *
 * « Reporter » agit sur la RÉUNION, pas sur l'événement : c'est le rendez-vous
 * qu'on déplace. L'attente de confirmation disparaît alors — il n'y a plus
 * rien à constater.
 */
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { ParticipantsField, participantsPrets } from '@/components/Participants';
import { DateField, TimeField, joinIso, splitIso } from '@/components/DateTimeField';
import type { MissedReason, Participant, ProjectEvent } from '@/types.events';

const MOTIFS: { value: MissedReason; label: string }[] = [
  { value: 'CANCELLED', label: 'Annulée' },
  { value: 'CLIENT_ABSENT', label: 'Client absent' },
  { value: 'TEAM_ABSENT', label: 'Équipe absente' },
  { value: 'OTHER', label: 'Autre motif' },
];

const heure = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const lignes = (texte: string) => texte.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

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
  const reel = splitIso(event.occurredAt);
  const [dateReelle, setDateReelle] = useState(reel.date);
  const [heureReelle, setHeureReelle] = useState(reel.time);
  // Les personnes attendues, prêtes à être corrigées : on confirme QUI était
  // là, et un absent se retire d'un bouton au lieu de se découper dans un texte.
  const [participants, setParticipants] = useState<Participant[]>(event.participants ?? []);
  const [motif, setMotif] = useState<MissedReason>('CLIENT_ABSENT');
  const [nouvelleDate, setNouvelleDate] = useState('');
  const [nouvelleHeure, setNouvelleHeure] = useState(reel.time);

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

  const avecQui = event.projectName || 'ce projet';

  return (
    <div className="alert alert-warning event-confirm">
      <p>
        <strong>La réunion avec {avecQui}</strong> prévue le {formatDateTime(event.occurredAt)} à{' '}
        {heure(event.occurredAt)} a-t-elle bien eu lieu ?
      </p>
      <p className="muted">{event.title}</p>

      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      {volet === null ? (
        <div className="contract-actions">
          <button type="button" className="btn btn-primary btn-small" onClick={() => setVolet('oui')}>
            Oui, elle a eu lieu
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setVolet('non')}>
            Non, elle n’a pas eu lieu
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={!event.sourceMeetingId}
            onClick={() => setVolet('reporter')}
          >
            Reporter
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
          <ParticipantsField
            participants={participants}
            onChange={setParticipants}
            hint="Personne n’était noté. Ajoutez celles et ceux qui étaient là."
          />
          <DateField label="Date réelle" value={dateReelle} onChange={setDateReelle} />
          <TimeField label="Heure réelle" value={heureReelle} onChange={setHeureReelle} />
          <div className="contract-actions">
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={enCours}
              onClick={() => void agir(() => api.confirmEvent(event._id, {
                notes,
                outcome,
                nextActions: lignes(actions),
                participants: participantsPrets(participants),
                ...(joinIso(dateReelle, heureReelle)
                  ? { occurredAt: joinIso(dateReelle, heureReelle) }
                  : {}),
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
          <DateField label="Nouvelle date" value={nouvelleDate} onChange={setNouvelleDate} />
          <TimeField label="Nouvelle heure" value={nouvelleHeure} onChange={setNouvelleHeure} />
          <p className="muted">
            La réunion d’origine est close et reliée à la nouvelle. Cette question disparaît :
            il n’y a plus rien à constater.
          </p>
          <div className="contract-actions">
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={enCours || !joinIso(nouvelleDate, nouvelleHeure)}
              onClick={() => void agir(() => api.rescheduleMeeting(event.sourceMeetingId as string, {
                scheduledAt: joinIso(nouvelleDate, nouvelleHeure),
                reason: 'Reportée',
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
