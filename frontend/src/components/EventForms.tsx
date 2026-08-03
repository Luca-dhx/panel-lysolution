/**
 * DEUX FORMULAIRES, parce que deux objets.
 *
 * Planifier une réunion, c'est décrire un rendez-vous À VENIR : un ordre du
 * jour, une durée, un lieu. Ajouter un événement passé, c'est consigner ce qui
 * A EU LIEU : une date réelle, un compte rendu, un résultat. Un formulaire
 * unique aurait affiché la moitié de ses champs grisés dans les deux cas.
 *
 * Aucun carnet de contacts : les participants externes se saisissent
 * librement. En fabriquer un ici créerait une donnée que personne ne tient à
 * jour.
 */
import { useState } from 'react';
import { Card } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useProjects } from '@/lib/useProjects';
import { projectDisplayName } from '@/lib/projectPresentation';
import { TYPE_LABELS } from '@/components/eventLabels';
import type { EventType } from '@/types.events';

const virgules = (texte: string) => texte.split(',').map((l) => l.trim()).filter(Boolean);
const lignes = (texte: string) => texte.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Types saisissables à la main. `MEETING_OCCURRED` naît d'une réunion, pas d'ici. */
const TYPES_MANUELS: EventType[] = ['CALL', 'VIDEO_CALL', 'MEAL', 'FOLLOW_UP', 'OTHER'];

function ChoixProjet({
  projectId,
  onChange,
}: {
  projectId: string;
  onChange: (id: string, nom: string) => void;
}) {
  const { projects } = useProjects();
  return (
    <label className="field">
      <span className="field-label">Projet</span>
      <select
        value={projectId}
        onChange={(e) => {
          const p = projects.find((x) => x.projectId === e.target.value);
          onChange(e.target.value, p ? projectDisplayName(p) : '');
        }}
      >
        <option value="">— choisir —</option>
        {projects.map((p) => (
          <option key={p.projectId} value={p.projectId}>{projectDisplayName(p)}</option>
        ))}
      </select>
    </label>
  );
}

/* ── PLANIFIER UNE RÉUNION ────────────────────────────────────────────────── */

export function MeetingForm({
  projectId: impose,
  projectName: nomImpose,
  onCreated,
  onCancel,
}: {
  projectId?: string;
  projectName?: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [projectId, setProjectId] = useState(impose ?? '');
  const [projectName, setProjectName] = useState(nomImpose ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [durationMinutes, setDuration] = useState(60);
  const [location, setLocation] = useState('');
  const [externes, setExternes] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const pret = projectId && title.trim().length > 0 && scheduledAt.length > 0;

  const envoyer = async () => {
    setErreur(null);
    setEnCours(true);
    try {
      await api.planMeeting({
        projectId,
        projectName: projectName || null,
        title: title.trim(),
        description,
        scheduledAt: new Date(scheduledAt).toISOString(),
        durationMinutes,
        location,
        externalParticipants: virgules(externes),
      });
      onCreated();
    } catch (err) {
      setErreur(errorMessage(err, 'La réunion n’a pas pu être planifiée.'));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Card title="Planifier une réunion">
      {erreur ? <div className="alert alert-error">{erreur}</div> : null}
      <div className="event-form">
        {impose ? null : (
          <ChoixProjet
            projectId={projectId}
            onChange={(id, nom) => { setProjectId(id); setProjectName(nom); }}
          />
        )}
        <label className="field">
          <span className="field-label">Intitulé</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex. : point mensuel" />
        </label>
        <label className="field">
          <span className="field-label">Date et heure</span>
          <input type="datetime-local" value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Durée (minutes)</span>
          <input type="number" min={0} value={durationMinutes}
            onChange={(e) => setDuration(Number(e.target.value))} />
        </label>
        <label className="field">
          <span className="field-label">Lieu ou lien de visioconférence</span>
          <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Participants externes</span>
          <input type="text" value={externes} onChange={(e) => setExternes(e.target.value)}
            placeholder="séparés par des virgules" />
        </label>
        <label className="field">
          <span className="field-label">Ordre du jour</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      <div className="contract-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={!pret || enCours}
          onClick={() => void envoyer()}>
          {enCours ? 'Enregistrement…' : 'Planifier'}
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </Card>
  );
}

/* ── AJOUTER UN ÉVÉNEMENT PASSÉ ───────────────────────────────────────────── */

export function PastEventForm({
  projectId: impose,
  projectName: nomImpose,
  onCreated,
  onCancel,
}: {
  projectId?: string;
  projectName?: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [projectId, setProjectId] = useState(impose ?? '');
  const [projectName, setProjectName] = useState(nomImpose ?? '');
  const [type, setType] = useState<EventType>('CALL');
  const [title, setTitle] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState('');
  const [actions, setActions] = useState('');
  const [externes, setExternes] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const pret = projectId && title.trim().length > 0 && occurredAt.length > 0;

  const envoyer = async () => {
    setErreur(null);
    setEnCours(true);
    try {
      await api.addPastEvent({
        projectId,
        projectName: projectName || null,
        type,
        title: title.trim(),
        occurredAt: new Date(occurredAt).toISOString(),
        notes,
        outcome,
        nextActions: lignes(actions),
        externalParticipants: virgules(externes),
      });
      onCreated();
    } catch (err) {
      setErreur(errorMessage(err, 'L’événement n’a pas pu être ajouté.'));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Card title="Ajouter un événement passé">
      {erreur ? <div className="alert alert-error">{erreur}</div> : null}
      <p className="muted">
        Un appel, un déjeuner, une relance — ce qui a eu lieu sans avoir été planifié.
        Une réunion prévue se confirme depuis l’agenda.
      </p>
      <div className="event-form">
        {impose ? null : (
          <ChoixProjet
            projectId={projectId}
            onChange={(id, nom) => { setProjectId(id); setProjectName(nom); }}
          />
        )}
        <label className="field">
          <span className="field-label">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as EventType)}>
            {TYPES_MANUELS.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Intitulé</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Quand cela s’est passé</span>
          <input type="datetime-local" value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Participants externes</span>
          <input type="text" value={externes} onChange={(e) => setExternes(e.target.value)}
            placeholder="séparés par des virgules" />
        </label>
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
      </div>
      <div className="contract-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={!pret || enCours}
          onClick={() => void envoyer()}>
          {enCours ? 'Enregistrement…' : 'Ajouter'}
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </Card>
  );
}
