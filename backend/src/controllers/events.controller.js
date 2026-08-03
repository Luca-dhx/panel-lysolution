// Agenda et événements de suivi — surface interne /api/events.
// Aucun appel de pont : ces données appartiennent au Panel.
import { created, ok } from '../utils/apiResponse.js';
import {
  cancelEvent,
  completeEvent,
  createEvent,
  describeProjectEvents,
  listEvents,
  listPendingConfirmations,
  missEvent,
  rescheduleEvent,
  snoozeEvent,
} from '../services/events/events.service.js';

/** L'initiateur d'une transition. Jamais anonyme : une décision a un auteur. */
const actorOf = (req) => ({
  email: req.panelUser?.email ?? null,
  role: req.panelUser?.role ?? null,
});

export async function list(req, res) {
  const { projectId = null, scope = 'upcoming' } = req.query ?? {};
  return ok(res, { events: await listEvents({ projectId, scope }) });
}

/** Ce qui attend une confirmation MAINTENANT — nourrit le badge et la boîte. */
export async function pending(_req, res) {
  return ok(res, { events: await listPendingConfirmations() });
}

export async function forProject(req, res) {
  return ok(res, await describeProjectEvents(req.params.projectId));
}

export async function create(req, res) {
  return created(res, { event: await createEvent(req.body, actorOf(req)) });
}

export async function complete(req, res) {
  return ok(res, { event: await completeEvent(req.params.eventId, req.body ?? {}, actorOf(req)) });
}

export async function miss(req, res) {
  return ok(res, { event: await missEvent(req.params.eventId, req.body ?? {}, actorOf(req)) });
}

export async function cancel(req, res) {
  return ok(res, { event: await cancelEvent(req.params.eventId, req.body ?? {}, actorOf(req)) });
}

export async function reschedule(req, res) {
  return ok(res, await rescheduleEvent(req.params.eventId, req.body ?? {}, actorOf(req)));
}

export async function snooze(req, res) {
  return ok(res, { event: await snoozeEvent(req.params.eventId, actorOf(req)) });
}
