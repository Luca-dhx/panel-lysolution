/**
 * ÉVÉNEMENTS — l'historique du suivi client.
 *
 * ── AUCUN PONT ──────────────────────────────────────────────────────────────
 * Rien ici n'appelle un projet. Ces faits sont nos notes de suivi ; les
 * envoyer au client serait publier notre carnet chez lui.
 *
 * ── CE QU'UN ÉVÉNEMENT EST, ET CE QU'IL N'EST PAS ───────────────────────────
 * Un événement est daté au passé et ne bouge plus. Il naît de deux façons : la
 * conversion d'une réunion arrivée à échéance, ou une saisie à la main — un
 * appel, un déjeuner, une relance, toutes choses qui arrivent sans avoir été
 * planifiées.
 *
 * Un événement issu d'une réunion naît « en attente de confirmation ». Le
 * temps ne dit pas si le rendez-vous a eu lieu ; seul un humain le sait.
 */
import ApiError from '../../utils/ApiError.js';
import {
  EVENT_STATUS,
  EVENT_TRANSITIONS,
  EVENT_TYPES,
  MISSED_REASONS,
  PanelProjectEvent,
} from '../../models/PanelProjectEvent.model.js';
import { MEETING_STATUS, PanelMeeting } from '../../models/PanelMeeting.model.js';
import { applyPatch } from './revisions.js';
import { normalizeParticipants, refuseLegacyParticipants } from './participants.js';

/** Valide une transition SANS l'appliquer. */
function assertTransition(from, to) {
  const autorisees = EVENT_TRANSITIONS[from] ?? [];
  if (!autorisees.includes(to)) {
    throw ApiError.conflict(
      'PANEL_EVENT_TRANSITION_FORBIDDEN',
      `Un événement ${from} ne peut pas passer à ${to}.`,
    );
  }
}

function transition(event, to) {
  assertTransition(event.status, to);
  event.status = to;
  return event;
}

/**
 * SAISIE MANUELLE d'un événement passé.
 *
 * Créé directement CONFIRMED : ce qui est saisi à la main est constaté par
 * celui qui le saisit. Lui demander de confirmer ce qu'il vient d'écrire
 * n'apprendrait rien à personne.
 */
export async function createPastEvent(data, actor = {}) {
  const {
    projectId, projectName = null, type = 'CALL', title,
    occurredAt, notes = '', outcome = '', nextActions = [],
    participants = [],
  } = data ?? {};

  refuseLegacyParticipants(data ?? {});
  if (!projectId) throw ApiError.badRequest('PANEL_EVENT_PROJECT_REQUIRED', 'Projet requis.');
  if (!title || !String(title).trim()) {
    throw ApiError.badRequest('PANEL_EVENT_TITLE_REQUIRED', 'Un intitulé est requis.');
  }
  if (!occurredAt || Number.isNaN(new Date(occurredAt).getTime())) {
    throw ApiError.badRequest('PANEL_EVENT_DATE_REQUIRED', 'Une date est requise.');
  }
  if (!EVENT_TYPES.includes(type)) {
    throw ApiError.badRequest('PANEL_EVENT_TYPE_UNKNOWN', 'Type d’événement inconnu.');
  }
  // `MEETING_OCCURRED` naît d'une réunion, pas d'une saisie : l'accepter ici
  // permettrait de fabriquer une réunion tenue qui n'a jamais été prévue.
  if (type === 'MEETING_OCCURRED') {
    throw ApiError.badRequest(
      'PANEL_EVENT_TYPE_RESERVED',
      'Une réunion tenue se confirme depuis l’agenda, elle ne se saisit pas à la main.',
    );
  }

  return PanelProjectEvent.create({
    projectId,
    projectName,
    sourceMeetingId: null,
    type,
    title: String(title).trim(),
    occurredAt: new Date(occurredAt),
    status: EVENT_STATUS.CONFIRMED,
    notes,
    outcome,
    nextActions: nextActions.filter(Boolean),
    participants: normalizeParticipants(participants),
    confirmedBy: actor.email ?? null,
    confirmedAt: new Date(),
    createdBy: actor.email ?? null,
    updatedBy: actor.email ?? null,
  });
}

async function loadOrThrow(eventId) {
  const event = await PanelProjectEvent.findById(eventId);
  if (!event) throw ApiError.notFound('PANEL_EVENT_NOT_FOUND', 'Événement introuvable.');
  return event;
}

/** La réunion liée a fini son rôle d'agenda : on ne la laisse pas « en attente ». */
async function closeSourceMeeting(event) {
  if (!event.sourceMeetingId) return;
  await PanelMeeting.updateOne(
    { _id: event.sourceMeetingId, status: MEETING_STATUS.DONE_PENDING_CONFIRMATION },
    { $set: { status: MEETING_STATUS.DONE_PENDING_CONFIRMATION } },
  );
}

/** « Oui, elle a eu lieu » — la seule voie vers CONFIRMED, et elle est humaine. */
export async function confirmEvent(eventId, data = {}, actor = {}) {
  refuseLegacyParticipants(data);
  const event = await loadOrThrow(eventId);
  transition(event, EVENT_STATUS.CONFIRMED);

  if (data.occurredAt && !Number.isNaN(new Date(data.occurredAt).getTime())) {
    event.occurredAt = new Date(data.occurredAt);
  }
  if (typeof data.notes === 'string') event.notes = data.notes;
  if (typeof data.outcome === 'string') event.outcome = data.outcome;
  if (Array.isArray(data.nextActions)) event.nextActions = data.nextActions.filter(Boolean);
  // Qui était VRAIMENT là : la liste prévue se corrige au moment de confirmer,
  // personne par personne, sans avoir à la retaper.
  if (data.participants !== undefined) event.participants = normalizeParticipants(data.participants);

  event.confirmedBy = actor.email ?? null;
  event.confirmedAt = new Date();
  event.updatedBy = actor.email ?? null;
  await event.save();
  await closeSourceMeeting(event);
  return event;
}

/** « Non » — le motif décide : une annulation n'est pas un rendez-vous manqué. */
export async function missEvent(eventId, { reason = 'OTHER', notes = '' } = {}, actor = {}) {
  if (!MISSED_REASONS.includes(reason)) {
    throw ApiError.badRequest('PANEL_EVENT_REASON_UNKNOWN', 'Motif inconnu.');
  }
  const event = await loadOrThrow(eventId);
  const cible = reason === 'CANCELLED' ? EVENT_STATUS.CANCELLED : EVENT_STATUS.MISSED;
  transition(event, cible);
  event.missedReason = reason;
  if (notes) event.notes = notes;
  event.confirmedBy = actor.email ?? null;
  event.confirmedAt = new Date();
  event.updatedBy = actor.email ?? null;
  await event.save();
  await closeSourceMeeting(event);
  return event;
}

/**
 * MODIFIER un événement — y compris confirmé, manqué ou annulé.
 *
 * On se trompe en confirmant, on apprend le lendemain que le client n'était
 * pas là, on complète un compte rendu. Refuser la correction ne rend pas
 * l'historique plus vrai : il le fige sur une erreur. Chaque champ touché est
 * consigné avec son avant et son après.
 */
export async function updateEvent(eventId, data = {}, actor = {}) {
  refuseLegacyParticipants(data);
  const event = await loadOrThrow(eventId);
  const patch = {};

  if (data.title !== undefined) {
    const title = String(data.title).trim();
    if (!title) throw ApiError.badRequest('PANEL_EVENT_TITLE_REQUIRED', 'Un intitulé est requis.');
    patch.title = title;
  }
  if (data.occurredAt !== undefined) {
    if (Number.isNaN(new Date(data.occurredAt).getTime())) {
      throw ApiError.badRequest('PANEL_EVENT_DATE_REQUIRED', 'Date invalide.');
    }
    patch.occurredAt = new Date(data.occurredAt);
  }
  if (data.type !== undefined) {
    if (!EVENT_TYPES.includes(data.type)) {
      throw ApiError.badRequest('PANEL_EVENT_TYPE_UNKNOWN', 'Type d’événement inconnu.');
    }
    patch.type = data.type;
  }
  if (data.notes !== undefined) patch.notes = data.notes;
  if (data.outcome !== undefined) patch.outcome = data.outcome;
  if (data.nextActions !== undefined) patch.nextActions = data.nextActions.filter(Boolean);
  if (data.participants !== undefined) patch.participants = normalizeParticipants(data.participants);

  // Reclasser reste possible, mais passe par la machine à états — et se
  // retrouve dans le journal comme n'importe quelle autre correction.
  if (data.status !== undefined && data.status !== event.status) {
    // On VALIDE la transition sans l'appliquer : c'est `applyPatch` qui écrit,
    // afin que le changement de statut apparaisse dans le journal comme les
    // autres. L'appliquer ici le rendrait invisible — il ne resterait plus
    // aucune différence à consigner.
    assertTransition(event.status, data.status);
    patch.status = data.status;
    if (data.missedReason !== undefined) patch.missedReason = data.missedReason;
  }

  const modifies = applyPatch(event, patch, { actor, reason: data.reason ?? null });
  await event.save();
  return { event, modifies };
}

/* ── Lectures ─────────────────────────────────────────────────────────────── */

/**
 * Ce qu'il faut confirmer.
 *
 * Plus de report de relance : « me le rappeler plus tard » n'existe plus. Une
 * question qu'on peut repousser indéfiniment finit par n'être jamais posée, et
 * le champ qui la portait ne servait qu'à ce bouton.
 */
export async function listPendingConfirmations() {
  return PanelProjectEvent.find({ status: EVENT_STATUS.PENDING_CONFIRMATION })
    .sort({ occurredAt: 1 }).lean();
}

/**
 * Événements d'un projet. `projectId` est OBLIGATOIRE quand on veut la fiche :
 * l'oublier afficherait l'historique du parc entier sur la fiche d'un client.
 */
export async function listEvents({
  projectId = null, status = null, type = null, limit = 200,
} = {}) {
  const filtre = {};
  if (projectId) filtre.projectId = projectId;
  if (status) filtre.status = status;
  if (type) filtre.type = type;
  return PanelProjectEvent.find(filtre).sort({ occurredAt: -1 }).limit(limit).lean();
}

/** Résumé d'un projet — à confirmer d'abord, puis l'histoire. */
export async function describeProjectEvents(projectId) {
  const [pending, history] = await Promise.all([
    PanelProjectEvent.find({ projectId, status: EVENT_STATUS.PENDING_CONFIRMATION })
      .sort({ occurredAt: 1 }).lean(),
    PanelProjectEvent.find({
      projectId,
      status: { $ne: EVENT_STATUS.PENDING_CONFIRMATION },
    }).sort({ occurredAt: -1 }).limit(50).lean(),
  ]);
  return { pending, history };
}

export default {
  createPastEvent,
  confirmEvent,
  missEvent,
  updateEvent,
  listEvents,
  listPendingConfirmations,
  describeProjectEvents,
};
