/**
 * ÉVÉNEMENTS DE SUIVI — création, transitions, échéances.
 *
 * ── AUCUN PONT ──────────────────────────────────────────────────────────────
 * Rien ici n'appelle un projet. Ces données sont celles de notre équipe ; les
 * envoyer au client serait publier notre agenda interne chez lui. Un test
 * vérifie qu'aucun client de pont n'est importé dans ce dossier.
 *
 * ── LE TEMPS NE CONFIRME RIEN ───────────────────────────────────────────────
 * L'échéance fait passer un événement de PLANNED à DUE — « à confirmer ». Elle
 * ne le termine jamais. Seul un humain peut dire qu'une réunion a eu lieu.
 */
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import {
  EVENT_STATUS,
  EVENT_TRANSITIONS,
  EVENT_TYPES,
  MISSED_REASONS,
  PanelProjectEvent,
} from '../../models/PanelProjectEvent.model.js';

const nowIso = () => new Date().toISOString();

/** Report de relance : assez long pour ne pas harceler, assez court pour servir. */
export const SNOOZE_MINUTES = 120;

/**
 * Applique une transition, ou refuse.
 *
 * Le refus est explicite plutôt que silencieux : un statut qui ne bouge pas
 * sans que personne ne le dise est la meilleure façon de croire qu'une réunion
 * est classée alors qu'elle ne l'est pas.
 */
function transition(event, to, { actor = {}, reason = null } = {}) {
  const autorisees = EVENT_TRANSITIONS[event.status] ?? [];
  if (!autorisees.includes(to)) {
    throw ApiError.conflict(
      'PANEL_EVENT_TRANSITION_FORBIDDEN',
      `Un événement ${event.status} ne peut pas passer à ${to}.`,
    );
  }
  event.transitions.push({
    at: nowIso(),
    from: event.status,
    to,
    actorEmail: actor.email ?? null,
    actorRole: actor.role ?? null,
    reason,
  });
  event.status = to;
  event.updatedBy = actor.email ?? null;
  return event;
}

/* -------------------------------------------------------------------------- */

export async function createEvent(data, actor = {}) {
  const {
    projectId, projectName = null, type = 'MEETING', title, description = '',
    scheduledAt, durationMinutes = 60,
    internalParticipants = [], externalParticipants = [],
    reportOfEventId = null,
  } = data ?? {};

  if (!projectId) throw ApiError.badRequest('PANEL_EVENT_PROJECT_REQUIRED', 'Projet requis.');
  if (!title || !String(title).trim()) {
    throw ApiError.badRequest('PANEL_EVENT_TITLE_REQUIRED', 'Un intitulé est requis.');
  }
  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    throw ApiError.badRequest('PANEL_EVENT_DATE_REQUIRED', 'Une date et une heure sont requises.');
  }
  if (!EVENT_TYPES.includes(type)) {
    throw ApiError.badRequest('PANEL_EVENT_TYPE_UNKNOWN', 'Type d’événement inconnu.');
  }

  const event = await PanelProjectEvent.create({
    projectId,
    projectName,
    type,
    title: String(title).trim(),
    description,
    scheduledAt: new Date(scheduledAt),
    durationMinutes,
    internalParticipants,
    externalParticipants,
    reportOfEventId,
    status: EVENT_STATUS.PLANNED,
    createdBy: actor.email ?? null,
    updatedBy: actor.email ?? null,
    transitions: [{
      at: nowIso(), from: null, to: EVENT_STATUS.PLANNED,
      actorEmail: actor.email ?? null, actorRole: actor.role ?? null, reason: null,
    }],
  });
  return event;
}

async function loadOrThrow(eventId) {
  const event = await PanelProjectEvent.findById(eventId);
  if (!event) throw ApiError.notFound('PANEL_EVENT_NOT_FOUND', 'Événement introuvable.');
  return event;
}

/** L'événement a eu lieu — la seule voie vers COMPLETED, et elle est humaine. */
export async function completeEvent(eventId, data = {}, actor = {}) {
  const event = await loadOrThrow(eventId);
  transition(event, EVENT_STATUS.COMPLETED, { actor, reason: data.reason ?? null });
  event.completedAt = new Date();
  event.occurredAt = data.occurredAt ? new Date(data.occurredAt) : event.scheduledAt;
  if (typeof data.notes === 'string') event.notes = data.notes;
  if (typeof data.outcome === 'string') event.outcome = data.outcome;
  if (Array.isArray(data.nextActions)) event.nextActions = data.nextActions.filter(Boolean);
  if (Array.isArray(data.internalParticipants)) event.internalParticipants = data.internalParticipants;
  if (Array.isArray(data.externalParticipants)) event.externalParticipants = data.externalParticipants;
  event.remindAfter = null;
  await event.save();
  return event;
}

/** L'événement n'a pas eu lieu. Le motif décide de MISSED ou CANCELLED. */
export async function missEvent(eventId, { reason = 'OTHER', notes = '' } = {}, actor = {}) {
  if (!MISSED_REASONS.includes(reason)) {
    throw ApiError.badRequest('PANEL_EVENT_REASON_UNKNOWN', 'Motif inconnu.');
  }
  const event = await loadOrThrow(eventId);
  // « Annulée » n'est pas « manquée » : l'une est une décision, l'autre un
  // constat. Les confondre fausserait toute lecture de l'historique.
  const cible = reason === 'CANCELLED' ? EVENT_STATUS.CANCELLED : EVENT_STATUS.MISSED;
  transition(event, cible, { actor, reason });
  event.missedReason = reason;
  if (notes) event.notes = notes;
  if (cible === EVENT_STATUS.CANCELLED) event.cancelledAt = new Date();
  event.remindAfter = null;
  await event.save();
  return event;
}

/** Annulation explicite, depuis PLANNED ou DUE. */
export async function cancelEvent(eventId, { reason = null } = {}, actor = {}) {
  const event = await loadOrThrow(eventId);
  transition(event, EVENT_STATUS.CANCELLED, { actor, reason });
  event.cancelledAt = new Date();
  event.remindAfter = null;
  await event.save();
  return event;
}

/**
 * REPORT — l'ancien événement est CLOS, un nouveau naît, et les deux se citent.
 *
 * Sans le lien retour, l'ancien deviendrait un cul-de-sac : on lirait
 * « annulé » sans jamais savoir que la réunion a bien eu lieu, deux semaines
 * plus tard.
 */
export async function rescheduleEvent(eventId, { scheduledAt, reason = null }, actor = {}) {
  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    throw ApiError.badRequest('PANEL_EVENT_DATE_REQUIRED', 'Une nouvelle date est requise.');
  }
  const ancien = await loadOrThrow(eventId);

  const nouveau = await createEvent({
    projectId: ancien.projectId,
    projectName: ancien.projectName,
    type: ancien.type,
    title: ancien.title,
    description: ancien.description,
    scheduledAt,
    durationMinutes: ancien.durationMinutes,
    internalParticipants: ancien.internalParticipants,
    externalParticipants: ancien.externalParticipants,
    reportOfEventId: String(ancien._id),
  }, actor);

  transition(ancien, EVENT_STATUS.CANCELLED, { actor, reason: reason ?? 'Reporté' });
  ancien.cancelledAt = new Date();
  ancien.rescheduledToEventId = String(nouveau._id);
  ancien.remindAfter = null;
  await ancien.save();

  return { previous: ancien, next: nouveau };
}

/** « Me le rappeler plus tard » — l'événement RESTE dû, la relance recule. */
export async function snoozeEvent(eventId, actor = {}) {
  const event = await loadOrThrow(eventId);
  if (event.status !== EVENT_STATUS.DUE) {
    throw ApiError.conflict(
      'PANEL_EVENT_NOT_DUE',
      'Seul un événement à confirmer peut être reporté à plus tard.',
    );
  }
  event.remindAfter = new Date(Date.now() + SNOOZE_MINUTES * 60_000);
  event.updatedBy = actor.email ?? null;
  await event.save();
  return event;
}

/* ── Échéances ────────────────────────────────────────────────────────────── */

/**
 * Passe à DUE tout ce dont l'heure est venue.
 *
 * IDEMPOTENT par construction : le filtre exige `status: PLANNED`, donc un
 * second passage ne trouve plus rien. Aucun doublon possible, même si deux
 * cycles se chevauchent.
 */
export async function markDueEvents(now = new Date()) {
  const echus = await PanelProjectEvent.find({
    status: EVENT_STATUS.PLANNED,
    scheduledAt: { $lte: now },
  });

  for (const event of echus) {
    transition(event, EVENT_STATUS.DUE, { actor: { email: null, role: 'SYSTEM' } });
    // eslint-disable-next-line no-await-in-loop
    await event.save();
  }
  if (echus.length > 0) {
    logger.info(`${echus.length} événement(s) passé(s) « à confirmer ».`);
  }
  return echus.length;
}

/* ── Lectures ─────────────────────────────────────────────────────────────── */

/** Ce qu'il faut confirmer MAINTENANT — les relances repoussées sont tues. */
export async function listPendingConfirmations(now = new Date()) {
  return PanelProjectEvent.find({
    status: EVENT_STATUS.DUE,
    $or: [{ remindAfter: null }, { remindAfter: { $lte: now } }],
  }).sort({ scheduledAt: 1 }).lean();
}

export async function listEvents({ projectId = null, scope = 'upcoming', limit = 100 } = {}) {
  const maintenant = new Date();
  const filtre = projectId ? { projectId } : {};

  if (scope === 'today') {
    const debut = new Date(maintenant); debut.setHours(0, 0, 0, 0);
    const fin = new Date(maintenant); fin.setHours(23, 59, 59, 999);
    filtre.scheduledAt = { $gte: debut, $lte: fin };
  } else if (scope === 'upcoming') {
    filtre.scheduledAt = { $gte: maintenant };
    filtre.status = { $in: [EVENT_STATUS.PLANNED, EVENT_STATUS.DUE] };
  } else if (scope === 'to_confirm') {
    filtre.status = EVENT_STATUS.DUE;
  } else if (scope === 'past') {
    filtre.status = { $in: [EVENT_STATUS.COMPLETED, EVENT_STATUS.MISSED, EVENT_STATUS.CANCELLED] };
  }

  const tri = scope === 'past' ? { scheduledAt: -1 } : { scheduledAt: 1 };
  return PanelProjectEvent.find(filtre).sort(tri).limit(limit).lean();
}

/** Résumé pour la fiche projet : le prochain, ceux à confirmer, l'historique. */
export async function describeProjectEvents(projectId) {
  const maintenant = new Date();
  const [next, toConfirm, history] = await Promise.all([
    PanelProjectEvent.findOne({
      projectId, status: EVENT_STATUS.PLANNED, scheduledAt: { $gte: maintenant },
    }).sort({ scheduledAt: 1 }).lean(),
    PanelProjectEvent.find({ projectId, status: EVENT_STATUS.DUE })
      .sort({ scheduledAt: 1 }).lean(),
    PanelProjectEvent.find({
      projectId,
      status: { $in: [EVENT_STATUS.COMPLETED, EVENT_STATUS.MISSED, EVENT_STATUS.CANCELLED] },
    }).sort({ scheduledAt: -1 }).limit(20).lean(),
  ]);
  return { next: next ?? null, toConfirm, history };
}

export default {
  createEvent,
  completeEvent,
  missEvent,
  cancelEvent,
  rescheduleEvent,
  snoozeEvent,
  markDueEvents,
  listEvents,
  listPendingConfirmations,
  describeProjectEvents,
};
