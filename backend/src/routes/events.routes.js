// Agenda et historique — surface interne /api/events et /api/meetings.
//
// ADMIN et DEV y ont accès : le suivi client est le quotidien de toute
// l'équipe, pas une opération d'infrastructure. Aucun RBAC fin dans ce lot.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  addPastEvent,
  cancelPlannedMeeting,
  confirm,
  events,
  forProject,
  meetings,
  miss,
  pending,
  planMeeting,
  reschedule,
  snooze,
} from '../controllers/events.controller.js';

const router = Router();
router.use(asyncHandler(requirePanelUser));

/* Réunions — objets d'AGENDA, futurs, déplaçables. */
router.get('/meetings', asyncHandler(meetings));
router.post('/meetings', asyncHandler(planMeeting));
router.post('/meetings/:meetingId/cancel', asyncHandler(cancelPlannedMeeting));
router.post('/meetings/:meetingId/reschedule', asyncHandler(reschedule));

/* Événements — objets d'HISTOIRE, passés, immuables une fois classés. */
router.get('/events', asyncHandler(events));
router.get('/events/pending', asyncHandler(pending));
router.get('/events/project/:projectId', asyncHandler(forProject));
router.post('/events', asyncHandler(addPastEvent));

// Une route par intention : « a eu lieu » et « n'a pas eu lieu » ne portent
// pas les mêmes informations, et un statut librement écrit contournerait la
// machine à états.
router.post('/events/:eventId/confirm', asyncHandler(confirm));
router.post('/events/:eventId/miss', asyncHandler(miss));
router.post('/events/:eventId/snooze', asyncHandler(snooze));

export default router;
