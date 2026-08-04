/** Lignes d'agenda et d'historique — deux formes, parce que deux natures. */
import { Link } from 'react-router-dom';
import { formatDateTime } from '@/lib/format';
import { toneBadgeClass } from '@/lib/projectPresentation';
import { TYPE_LABELS, eventStatusState, meetingImminence } from '@/components/eventLabels';
import { ParticipantsSummary } from '@/components/Participants';
import { Icon } from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { lienTelephone } from '@/components/Links';
import type { Meeting, ProjectEvent } from '@/types.events';

/**
 * L'icône dit le MODE avant toute lecture : on reconnaît un déplacement d'un
 * appel sans avoir à lire la ligne.
 */
function iconeMode(m: Meeting): IconName {
  if (m.mode === 'ONSITE') return 'geo-alt';
  return m.remoteKind === 'CALL' ? 'telephone' : 'camera-video';
}

function libelleMode(m: Meeting): string {
  if (m.mode === 'ONSITE') return 'Présentiel';
  return m.remoteKind === 'CALL' ? 'Appel' : 'Visioconférence';
}

const heure = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const jour = (iso: string) =>
  new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/**
 * Un lien de visioconférence n'est cliquable que s'il MÈNE quelque part.
 *
 * Le serveur valide déjà le lien à l'enregistrement ; une fiche ancienne peut
 * cependant porter n'importe quoi. On ne fabrique pas un bouton qui ouvrirait
 * une page blanche.
 */
function lienVisio(m: Meeting): string | null {
  if (m.mode !== 'REMOTE' || m.remoteKind !== 'VIDEO' || !m.meetingUrl) return null;
  try {
    const url = new URL(m.meetingUrl);
    return /^(https|msteams|zoommtg|webex):$/.test(url.protocol) ? m.meetingUrl : null;
  } catch {
    return null;
  }
}

/**
 * UNE RÉUNION PRÉVUE.
 *
 * La ligne d'agenda était une suite de fragments séparés par des points
 * médians : intitulé, projet, durée, lieu, tout au même niveau et sur un même
 * gris. Rien ne ressortait, et le lien de visioconférence — la seule chose
 * qu'on vient chercher à l'heure dite — n'apparaissait nulle part.
 *
 * La carte hiérarchise : l'intitulé domine, la date et le lieu se lisent d'un
 * coup avec leur icône, et l'action utile est un BOUTON.
 */
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
  // Une réunion proche le DIT : « Demain », « Dans 20 min ». Le calcul est
  // dans `meetingImminence`, et il n'y a aucun minuteur ici — le
  // rafraîchissement vivant de l'agenda suffit à faire évoluer la pastille.
  const etat = meetingImminence(meeting.scheduledAt, meeting.status);
  const modifiable = meeting.status === 'PLANNED' || meeting.status === 'DONE_PENDING_CONFIRMATION';
  const visio = lienVisio(meeting);

  return (
    <li className="meeting-card">
      <div className="meeting-card-head">
        <span className="meeting-card-icon"><Icon name={iconeMode(meeting)} size={20} /></span>
        <div className="meeting-card-title">
          <span className="meeting-card-name">{meeting.title}</span>
          {showProject && meeting.projectName ? (
            <span className="meeting-card-project">
              <Icon name="building" size={13} />
              {meeting.projectName}
            </span>
          ) : null}
        </div>
        <span className={toneBadgeClass(etat.tone)}>
          {etat.imminent ? <Icon name="clock" size={12} /> : null}
          {etat.label}
        </span>
      </div>

      <div className="meeting-card-facts">
        <span className="meeting-fact">
          <Icon name="calendar-event" size={14} />
          {jour(meeting.scheduledAt)}
        </span>
        <span className="meeting-fact">
          <Icon name="clock" size={14} />
          {heure(meeting.scheduledAt)}
          {meeting.durationMinutes ? ` · ${meeting.durationMinutes} min` : ''}
        </span>
        <span className="meeting-fact">
          <Icon name={iconeMode(meeting)} size={14} />
          {libelleMode(meeting)}
        </span>
      </div>

      {/* OÙ, exactement — une seule ligne, celle qui correspond au mode. */}
      {meeting.mode === 'ONSITE' && meeting.address ? (
        <p className="meeting-place">
          <Icon name="geo-alt" size={14} />
          <span className="meeting-place-value">
            {meeting.address}
            {meeting.addressComplement ? `, ${meeting.addressComplement}` : ''}
          </span>
        </p>
      ) : null}

      {meeting.remoteKind === 'CALL' && meeting.phone ? (
        <p className="meeting-place">
          <Icon name="telephone" size={14} />
          <a className="link-action" href={lienTelephone(meeting.phone)}>
            <span className="link-action-value">{meeting.phone}</span>
          </a>
        </p>
      ) : null}

      {meeting.participants.length > 0 ? (
        <p className="meeting-place">
          <Icon name="people" size={14} />
          <ParticipantsSummary participants={meeting.participants} />
        </p>
      ) : null}

      <div className="meeting-card-actions">
        {visio ? (
          <a
            className="btn btn-primary btn-small meeting-join"
            href={visio}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="camera-video" size={14} />
            Rejoindre la réunion
          </a>
        ) : null}
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
      </div>
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
        {/* Le résultat et les prochaines actions ne sont plus DEMANDÉS à la
            confirmation, mais tout ce qui a été saisi avant reste lisible. */}
        {event.outcome ? <span className="muted">{event.outcome}</span> : null}
        {event.nextActions.length > 0 ? (
          <span className="muted">{event.nextActions.length} action(s) à suivre</span>
        ) : null}
        <ParticipantsSummary participants={event.participants} />
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
