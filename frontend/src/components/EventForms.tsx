/**
 * DEUX FORMULAIRES, parce que deux objets.
 *
 * Planifier une réunion décrit un rendez-vous À VENIR : un ordre du jour, une
 * durée, un lieu. Ajouter un événement passé consigne ce qui A EU LIEU : une
 * date réelle, un compte rendu. Un formulaire unique aurait grisé la moitié de
 * ses champs dans les deux cas.
 *
 * Les deux servent aussi à MODIFIER : corriger une erreur de saisie ne devrait
 * jamais obliger à supprimer et resaisir.
 *
 * Aucun carnet de contacts : les participants se saisissent librement, mais
 * sous forme de LISTE — une personne, une ligne. En fabriquer un carnet ici
 * créerait une donnée que personne ne tient à jour.
 */
import { useState } from 'react';
import { Card } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useProjects } from '@/lib/useProjects';
import { projectDisplayName } from '@/lib/projectPresentation';
import { TYPE_LABELS } from '@/components/eventLabels';
import { ParticipantsField, participantsPrets } from '@/components/Participants';
import { DateField, DurationField, TimeField, joinIso, splitIso } from '@/components/DateTimeField';
import type { EventType, Meeting, Participant, ProjectEvent } from '@/types.events';

const lignes = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Types saisissables à la main. `MEETING_OCCURRED` naît d'une réunion. */
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

/* ── RÉUNION ──────────────────────────────────────────────────────────────── */

export function MeetingForm({
  projectId: impose,
  projectName: nomImpose,
  meeting,
  onSaved,
  onCancel,
}: {
  projectId?: string;
  projectName?: string;
  /** Présente = MODIFICATION ; absente = création. */
  meeting?: Meeting;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const initial = meeting ? splitIso(meeting.scheduledAt) : { date: '', time: '' };

  const [projectId, setProjectId] = useState(meeting?.projectId ?? impose ?? '');
  const [projectName, setProjectName] = useState(meeting?.projectName ?? nomImpose ?? '');
  const [title, setTitle] = useState(meeting?.title ?? '');
  const [description, setDescription] = useState(meeting?.description ?? '');
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [durationMinutes, setDuration] = useState(meeting?.durationMinutes ?? 60);
  const [participants, setParticipants] = useState<Participant[]>(meeting?.participants ?? []);

  // Mode — le sélecteur pilote quels champs existent, pas seulement lesquels
  // sont visibles : le serveur efface ce qui n'a plus de sens.
  const [mode, setMode] = useState<'ONSITE' | 'REMOTE'>(meeting?.mode ?? 'ONSITE');
  const [remoteKind, setRemoteKind] = useState<'CALL' | 'VIDEO'>(meeting?.remoteKind ?? 'VIDEO');
  const [address, setAddress] = useState(meeting?.address ?? '');
  const [addressComplement, setComplement] = useState(meeting?.addressComplement ?? '');
  const [accessNotes, setAccess] = useState(meeting?.accessNotes ?? '');
  const [phone, setPhone] = useState(meeting?.phone ?? '');
  const [meetingUrl, setUrl] = useState(meeting?.meetingUrl ?? '');
  const [reason, setReason] = useState('');

  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const quand = joinIso(date, time);
  const lieuPret = mode === 'ONSITE'
    ? address.trim().length > 0
    : remoteKind === 'CALL' ? phone.trim().length > 0 : meetingUrl.trim().length > 0;
  const pret = Boolean(projectId && title.trim() && quand && lieuPret);

  const envoyer = async () => {
    setErreur(null);
    setEnCours(true);
    const corps = {
      projectId,
      projectName: projectName || null,
      title: title.trim(),
      description,
      scheduledAt: quand,
      durationMinutes,
      mode,
      ...(mode === 'ONSITE'
        ? { address, addressComplement, accessNotes }
        : { remoteKind, ...(remoteKind === 'CALL' ? { phone } : { meetingUrl }) }),
      participants: participantsPrets(participants),
      ...(meeting && reason.trim() ? { reason: reason.trim() } : {}),
    };
    try {
      if (meeting) await api.updateMeeting(meeting._id, corps);
      else await api.planMeeting(corps);
      onSaved();
    } catch (err) {
      setErreur(errorMessage(err, 'La réunion n’a pas pu être enregistrée.'));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Card title={meeting ? 'Modifier la réunion' : 'Planifier une réunion'}>
      {erreur ? <div className="alert alert-error">{erreur}</div> : null}

      <div className="event-form">
        {impose || meeting ? null : (
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
        <DateField label="Date" value={date} onChange={setDate} />
        <TimeField label="Heure" value={time} onChange={setTime} />
        <DurationField label="Durée" value={durationMinutes} onChange={setDuration} />
      </div>

      {/* ── MODE ────────────────────────────────────────────────────────── */}
      <div className="field">
        <span className="field-label">Comment se voit-on ?</span>
        <div className="segmented" role="group" aria-label="Mode de réunion">
          <button
            type="button"
            className={mode === 'ONSITE' ? 'segment segment-active' : 'segment'}
            aria-pressed={mode === 'ONSITE'}
            onClick={() => setMode('ONSITE')}
          >
            Présentiel
          </button>
          <button
            type="button"
            className={mode === 'REMOTE' ? 'segment segment-active' : 'segment'}
            aria-pressed={mode === 'REMOTE'}
            onClick={() => setMode('REMOTE')}
          >
            Distanciel
          </button>
        </div>
      </div>

      {mode === 'ONSITE' ? (
        <div className="event-form">
          <label className="field">
            <span className="field-label">Adresse</span>
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)}
              placeholder="12 rue de la République, 06000 Nice" />
          </label>
          <label className="field">
            <span className="field-label">Complément <span className="muted">(facultatif)</span></span>
            <input type="text" value={addressComplement} onChange={(e) => setComplement(e.target.value)}
              placeholder="Bâtiment B, 2e étage" />
          </label>
          <label className="field">
            <span className="field-label">Accès <span className="muted">(facultatif)</span></span>
            <input type="text" value={accessNotes} onChange={(e) => setAccess(e.target.value)}
              placeholder="Sonner à l’atelier" />
          </label>
        </div>
      ) : (
        <>
          <div className="field">
            <span className="field-label">Par quel moyen ?</span>
            <div className="segmented" role="group" aria-label="Type de réunion à distance">
              <button
                type="button"
                className={remoteKind === 'CALL' ? 'segment segment-active' : 'segment'}
                aria-pressed={remoteKind === 'CALL'}
                onClick={() => setRemoteKind('CALL')}
              >
                Appel
              </button>
              <button
                type="button"
                className={remoteKind === 'VIDEO' ? 'segment segment-active' : 'segment'}
                aria-pressed={remoteKind === 'VIDEO'}
                onClick={() => setRemoteKind('VIDEO')}
              >
                Visioconférence
              </button>
            </div>
          </div>
          <div className="event-form">
            {remoteKind === 'CALL' ? (
              <label className="field">
                <span className="field-label">Numéro à appeler</span>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                  placeholder="06 12 34 56 78" />
              </label>
            ) : (
              <label className="field">
                <span className="field-label">Lien de la réunion</span>
                <input type="url" value={meetingUrl} onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://…" />
              </label>
            )}
          </div>
        </>
      )}

      <ParticipantsField
        participants={participants}
        onChange={setParticipants}
        hint="Personne pour l’instant. Ajoutez celles et ceux qui sont attendus."
      />

      <div className="event-form">
        <label className="field">
          <span className="field-label">Ordre du jour</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {meeting ? (
          <label className="field">
            <span className="field-label">Motif de la modification <span className="muted">(facultatif)</span></span>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        ) : null}
      </div>

      <div className="contract-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={!pret || enCours}
          onClick={() => void envoyer()}>
          {enCours ? 'Enregistrement…' : meeting ? 'Enregistrer' : 'Planifier'}
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </Card>
  );
}

/* ── ÉVÉNEMENT PASSÉ ──────────────────────────────────────────────────────── */

export function PastEventForm({
  projectId: impose,
  projectName: nomImpose,
  event,
  onSaved,
  onCancel,
}: {
  projectId?: string;
  projectName?: string;
  event?: ProjectEvent;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const initial = event ? splitIso(event.occurredAt) : { date: '', time: '' };

  const [projectId, setProjectId] = useState(event?.projectId ?? impose ?? '');
  const [projectName, setProjectName] = useState(event?.projectName ?? nomImpose ?? '');
  const [type, setType] = useState<EventType>(event?.type ?? 'CALL');
  const [title, setTitle] = useState(event?.title ?? '');
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [notes, setNotes] = useState(event?.notes ?? '');
  const [outcome, setOutcome] = useState(event?.outcome ?? '');
  const [actions, setActions] = useState(event?.nextActions.join('\n') ?? '');
  const [participants, setParticipants] = useState<Participant[]>(event?.participants ?? []);
  const [reason, setReason] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const quand = joinIso(date, time);
  const pret = Boolean(projectId && title.trim() && quand);
  // Une réunion tenue garde son type : il vient de l'agenda, pas d'un choix.
  const typeVerrouille = event?.type === 'MEETING_OCCURRED';

  const envoyer = async () => {
    setErreur(null);
    setEnCours(true);
    const corps = {
      projectId,
      projectName: projectName || null,
      ...(typeVerrouille ? {} : { type }),
      title: title.trim(),
      occurredAt: quand,
      notes,
      outcome,
      nextActions: lignes(actions),
      participants: participantsPrets(participants),
      ...(event && reason.trim() ? { reason: reason.trim() } : {}),
    };
    try {
      if (event) await api.updateEvent(event._id, corps);
      else await api.addPastEvent(corps);
      onSaved();
    } catch (err) {
      setErreur(errorMessage(err, 'L’événement n’a pas pu être enregistré.'));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Card title={event ? 'Modifier l’événement' : 'Ajouter un événement passé'}>
      {erreur ? <div className="alert alert-error">{erreur}</div> : null}
      {event ? null : (
        <p className="muted">
          Un appel, un déjeuner, une relance — ce qui a eu lieu sans avoir été planifié.
          Une réunion prévue se confirme depuis l’agenda.
        </p>
      )}

      <div className="event-form">
        {impose || event ? null : (
          <ChoixProjet
            projectId={projectId}
            onChange={(id, nom) => { setProjectId(id); setProjectName(nom); }}
          />
        )}
        {typeVerrouille ? null : (
          <label className="field">
            <span className="field-label">Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as EventType)}>
              {TYPES_MANUELS.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
          </label>
        )}
        <label className="field">
          <span className="field-label">Intitulé</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <DateField label="Date" value={date} onChange={setDate} />
        <TimeField label="Heure" value={time} onChange={setTime} />
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
        {event ? (
          <label className="field">
            <span className="field-label">Motif de la modification <span className="muted">(facultatif)</span></span>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        ) : null}
      </div>

      <ParticipantsField
        participants={participants}
        onChange={setParticipants}
        hint="Personne pour l’instant. Ajoutez celles et ceux qui étaient là."
      />

      <div className="contract-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={!pret || enCours}
          onClick={() => void envoyer()}>
          {enCours ? 'Enregistrement…' : event ? 'Enregistrer' : 'Ajouter'}
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </Card>
  );
}
