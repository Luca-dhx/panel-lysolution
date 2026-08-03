/**
 * PLANIFIER UN ÉVÉNEMENT.
 *
 * Le projet est OBLIGATOIRE : un rendez-vous sans client ne se retrouve nulle
 * part, ni dans une fiche, ni dans un historique. Les participants externes se
 * saisissent librement — le Panel n'a pas de carnet de contacts, et en
 * fabriquer un ici serait construire une donnée que personne ne tient à jour.
 */
import { useState } from 'react';
import { Card } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useProjects } from '@/lib/useProjects';
import { projectDisplayName } from '@/lib/projectPresentation';
import type { EventType } from '@/types.events';

const TYPES: { value: EventType; label: string }[] = [
  { value: 'MEETING', label: 'Réunion' },
  { value: 'CALL', label: 'Appel' },
  { value: 'VIDEO_CALL', label: 'Visioconférence' },
  { value: 'MEAL', label: 'Repas' },
  { value: 'FOLLOW_UP', label: 'Relance' },
  { value: 'OTHER', label: 'Autre' },
];

export function EventForm({
  projectId: projectImpose,
  onCreated,
  onCancel,
}: {
  projectId?: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { projects } = useProjects();
  const [projectId, setProjectId] = useState(projectImpose ?? '');
  const [type, setType] = useState<EventType>('MEETING');
  const [title, setTitle] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [durationMinutes, setDuration] = useState(60);
  const [externes, setExternes] = useState('');
  const [description, setDescription] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const projet = projects.find((p) => p.projectId === projectId);

  const envoyer = async () => {
    setErreur(null);
    setEnCours(true);
    try {
      await api.createEvent({
        projectId,
        projectName: projet ? projectDisplayName(projet) : null,
        type,
        title: title.trim(),
        description,
        scheduledAt: new Date(scheduledAt).toISOString(),
        durationMinutes,
        externalParticipants: externes.split(',').map((p) => p.trim()).filter(Boolean),
      });
      onCreated();
    } catch (err) {
      setErreur(errorMessage(err, 'L’événement n’a pas pu être créé.'));
    } finally {
      setEnCours(false);
    }
  };

  const pret = projectId && title.trim().length > 0 && scheduledAt.length > 0;

  return (
    <Card title="Planifier un événement">
      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      <div className="event-form">
        {projectImpose ? null : (
          <label className="field">
            <span className="field-label">Projet</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">— choisir —</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>{projectDisplayName(p)}</option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span className="field-label">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as EventType)}>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Intitulé</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex. : point mensuel"
          />
        </label>

        <label className="field">
          <span className="field-label">Date et heure</span>
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Durée (minutes)</span>
          <input
            type="number"
            min={0}
            value={durationMinutes}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span className="field-label">Participants externes</span>
          <input
            type="text"
            value={externes}
            onChange={(e) => setExternes(e.target.value)}
            placeholder="séparés par des virgules"
          />
        </label>

        <label className="field">
          <span className="field-label">Note interne</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>

      <div className="contract-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={!pret || enCours}
          onClick={() => void envoyer()}
        >
          {enCours ? 'Enregistrement…' : 'Planifier'}
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </Card>
  );
}
