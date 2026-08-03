/**
 * RÉUNIONS — l'agenda de l'équipe.
 *
 * ── AUCUN PONT ──────────────────────────────────────────────────────────────
 * Rien ici n'appelle un projet. Ce sont nos rendez-vous, pas les siens.
 *
 * ── LA CONVERSION, ET POURQUOI ELLE EST LE CŒUR ─────────────────────────────
 * À l'échéance, une réunion ne devient pas « tenue » : elle devient « à
 * confirmer », et engendre UN événement en attente. C'est cet événement que
 * l'opérateur classera. La réunion, elle, a fini son travail d'agenda.
 *
 * Un seul événement par réunion, garanti par un index unique sur
 * `sourceMeetingId` : deux cycles concurrents ne peuvent pas créer deux
 * confirmations pour le même rendez-vous.
 */
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { MEETING_STATUS, MEETING_TRANSITIONS, PanelMeeting } from '../../models/PanelMeeting.model.js';
import { EVENT_STATUS, PanelProjectEvent } from '../../models/PanelProjectEvent.model.js';

function transition(meeting, to) {
  const autorisees = MEETING_TRANSITIONS[meeting.status] ?? [];
  if (!autorisees.includes(to)) {
    throw ApiError.conflict(
      'PANEL_MEETING_TRANSITION_FORBIDDEN',
      `Une réunion ${meeting.status} ne peut pas passer à ${to}.`,
    );
  }
  meeting.status = to;
  return meeting;
}

export async function createMeeting(data, actor = {}) {
  const {
    projectId, projectName = null, title, description = '',
    scheduledAt, durationMinutes = 60, location = '',
    internalParticipants = [], externalParticipants = [],
    rescheduledFromMeetingId = null,
  } = data ?? {};

  if (!projectId) throw ApiError.badRequest('PANEL_MEETING_PROJECT_REQUIRED', 'Projet requis.');
  if (!title || !String(title).trim()) {
    throw ApiError.badRequest('PANEL_MEETING_TITLE_REQUIRED', 'Un intitulé est requis.');
  }
  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    throw ApiError.badRequest('PANEL_MEETING_DATE_REQUIRED', 'Une date et une heure sont requises.');
  }

  return PanelMeeting.create({
    projectId,
    projectName,
    title: String(title).trim(),
    description,
    scheduledAt: new Date(scheduledAt),
    durationMinutes,
    location,
    internalParticipants,
    externalParticipants,
    rescheduledFromMeetingId,
    status: MEETING_STATUS.PLANNED,
    createdBy: actor.email ?? null,
    updatedBy: actor.email ?? null,
  });
}

async function loadOrThrow(meetingId) {
  const meeting = await PanelMeeting.findById(meetingId);
  if (!meeting) throw ApiError.notFound('PANEL_MEETING_NOT_FOUND', 'Réunion introuvable.');
  return meeting;
}

export async function cancelMeeting(meetingId, { reason = null } = {}, actor = {}) {
  const meeting = await loadOrThrow(meetingId);
  transition(meeting, MEETING_STATUS.CANCELLED);
  meeting.cancelledAt = new Date();
  meeting.cancelReason = reason;
  meeting.updatedBy = actor.email ?? null;
  await meeting.save();

  // Une réunion annulée n'a plus rien à confirmer : l'attente disparaît.
  await PanelProjectEvent.deleteOne({
    sourceMeetingId: String(meeting._id),
    status: EVENT_STATUS.PENDING_CONFIRMATION,
  });
  return meeting;
}

/**
 * REPORT — l'ancienne réunion est close, une nouvelle naît, les deux se citent.
 *
 * L'événement de confirmation éventuellement créé à l'échéance est SUPPRIMÉ.
 * Un événement consigne ce qui s'est passé ; une réunion reportée n'a rien
 * produit à consigner. Le laisser aurait fabriqué un doublon dans l'historique
 * — et une question à laquelle personne ne peut répondre. La trace du report
 * vit dans les deux réunions, qui se pointent l'une l'autre.
 */
export async function rescheduleMeeting(meetingId, { scheduledAt, reason = null }, actor = {}) {
  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    throw ApiError.badRequest('PANEL_MEETING_DATE_REQUIRED', 'Une nouvelle date est requise.');
  }
  const ancienne = await loadOrThrow(meetingId);

  const nouvelle = await createMeeting({
    projectId: ancienne.projectId,
    projectName: ancienne.projectName,
    title: ancienne.title,
    description: ancienne.description,
    scheduledAt,
    durationMinutes: ancienne.durationMinutes,
    location: ancienne.location,
    internalParticipants: ancienne.internalParticipants,
    externalParticipants: ancienne.externalParticipants,
    rescheduledFromMeetingId: String(ancienne._id),
  }, actor);

  transition(ancienne, MEETING_STATUS.RESCHEDULED);
  ancienne.rescheduledToMeetingId = String(nouvelle._id);
  ancienne.cancelReason = reason;
  ancienne.updatedBy = actor.email ?? null;
  await ancienne.save();

  await PanelProjectEvent.deleteOne({
    sourceMeetingId: String(ancienne._id),
    status: EVENT_STATUS.PENDING_CONFIRMATION,
  });

  return { previous: ancienne, next: nouvelle };
}

/* ── Échéances ────────────────────────────────────────────────────────────── */

/**
 * Toute réunion dont l'heure est venue passe « à confirmer » et engendre son
 * événement en attente.
 *
 * IDEMPOTENT deux fois plutôt qu'une : le filtre exige `PLANNED` — un second
 * passage ne trouve plus rien — et l'index unique sur `sourceMeetingId` refuse
 * un second événement même si deux cycles se croisaient.
 */
export async function convertDueMeetings(now = new Date()) {
  const echues = await PanelMeeting.find({
    status: MEETING_STATUS.PLANNED,
    scheduledAt: { $lte: now },
  });

  let crees = 0;
  for (const meeting of echues) {
    meeting.status = MEETING_STATUS.DONE_PENDING_CONFIRMATION;
    // eslint-disable-next-line no-await-in-loop
    await meeting.save();

    try {
      // eslint-disable-next-line no-await-in-loop
      await PanelProjectEvent.create({
        projectId: meeting.projectId,
        projectName: meeting.projectName,
        sourceMeetingId: String(meeting._id),
        type: 'MEETING_OCCURRED',
        title: meeting.title,
        occurredAt: meeting.scheduledAt,
        status: EVENT_STATUS.PENDING_CONFIRMATION,
        internalParticipants: meeting.internalParticipants,
        externalParticipants: meeting.externalParticipants,
        createdBy: null, // la conversion n'a pas d'auteur humain
      });
      crees += 1;
    } catch (err) {
      // 11000 : la confirmation existe déjà. C'est le résultat voulu.
      if (err?.code !== 11000) throw err;
    }
  }

  if (echues.length > 0) {
    logger.info(`${echues.length} réunion(s) passée(s) « à confirmer » (${crees} nouvelle(s)).`);
  }
  return { meetings: echues.length, events: crees };
}

/* ── Lectures ─────────────────────────────────────────────────────────────── */

export async function listMeetings({ projectId = null, scope = 'upcoming', limit = 100 } = {}) {
  const maintenant = new Date();
  const filtre = projectId ? { projectId } : {};

  if (scope === 'upcoming') {
    filtre.status = MEETING_STATUS.PLANNED;
    filtre.scheduledAt = { $gte: maintenant };
  } else if (scope === 'today') {
    const debut = new Date(maintenant); debut.setHours(0, 0, 0, 0);
    const fin = new Date(maintenant); fin.setHours(23, 59, 59, 999);
    filtre.scheduledAt = { $gte: debut, $lte: fin };
  } else if (scope === 'to_confirm') {
    filtre.status = MEETING_STATUS.DONE_PENDING_CONFIRMATION;
  } else if (scope === 'past') {
    filtre.scheduledAt = { $lt: maintenant };
  }

  const tri = scope === 'past' ? { scheduledAt: -1 } : { scheduledAt: 1 };
  return PanelMeeting.find(filtre).sort(tri).limit(limit).lean();
}

export default {
  createMeeting,
  cancelMeeting,
  rescheduleMeeting,
  convertDueMeetings,
  listMeetings,
};
