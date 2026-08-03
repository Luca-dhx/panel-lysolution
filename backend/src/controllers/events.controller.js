// Agenda (réunions) et historique (événements) — surface interne /api.
// Aucun appel de pont : ces données appartiennent au Panel.
import ApiError from '../utils/ApiError.js';
import { created, ok } from '../utils/apiResponse.js';
import {
  cancelMeeting,
  createMeeting,
  listMeetings,
  rescheduleMeeting,
} from '../services/events/meetings.service.js';
import {
  confirmEvent,
  createPastEvent,
  describeProjectEvents,
  listEvents,
  listPendingConfirmations,
  missEvent,
  snoozeEvent,
} from '../services/events/events.service.js';

/** L'auteur d'une décision. Jamais anonyme. */
const actorOf = (req) => ({
  email: req.panelUser?.email ?? null,
  role: req.panelUser?.role ?? null,
});

/* ── RÉUNIONS — l'agenda ───────────────────────────────────────────────────── */

export async function meetings(req, res) {
  const { projectId = null, scope = 'upcoming' } = req.query ?? {};
  return ok(res, { meetings: await listMeetings({ projectId, scope }) });
}

export async function planMeeting(req, res) {
  return created(res, { meeting: await createMeeting(req.body, actorOf(req)) });
}

export async function cancelPlannedMeeting(req, res) {
  return ok(res, { meeting: await cancelMeeting(req.params.meetingId, req.body ?? {}, actorOf(req)) });
}

export async function reschedule(req, res) {
  return ok(res, await rescheduleMeeting(req.params.meetingId, req.body ?? {}, actorOf(req)));
}

/* ── ÉVÉNEMENTS — l'historique ─────────────────────────────────────────────── */

/**
 * Les événements se lisent PAR PROJET.
 *
 * `projectId` est exigé sur la fiche : l'omettre afficherait l'historique du
 * parc entier sous le nom d'un seul client. La vue globale existe, mais elle
 * se demande explicitement (`scope=all`).
 */
export async function events(req, res) {
  const { projectId = null, status = null, type = null, scope = null } = req.query ?? {};
  if (!projectId && scope !== 'all') {
    throw ApiError.badRequest(
      'PANEL_EVENT_PROJECT_REQUIRED',
      'Précisez un projet, ou demandez explicitement la vue globale.',
    );
  }
  return ok(res, { events: await listEvents({ projectId, status, type }) });
}

export async function pending(_req, res) {
  return ok(res, { events: await listPendingConfirmations() });
}

export async function forProject(req, res) {
  return ok(res, await describeProjectEvents(req.params.projectId));
}

export async function addPastEvent(req, res) {
  return created(res, { event: await createPastEvent(req.body, actorOf(req)) });
}

export async function confirm(req, res) {
  return ok(res, { event: await confirmEvent(req.params.eventId, req.body ?? {}, actorOf(req)) });
}

export async function miss(req, res) {
  return ok(res, { event: await missEvent(req.params.eventId, req.body ?? {}, actorOf(req)) });
}

export async function snooze(req, res) {
  return ok(res, { event: await snoozeEvent(req.params.eventId, actorOf(req)) });
}
