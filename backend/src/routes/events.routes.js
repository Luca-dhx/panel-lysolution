// Agenda et événements de suivi — surface interne /api/events.
//
// ADMIN et DEV y ont accès : le suivi client est le quotidien de toute
// l'équipe, pas une opération d'infrastructure. Aucun RBAC fin dans ce lot.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  cancel,
  complete,
  create,
  forProject,
  list,
  miss,
  pending,
  reschedule,
  snooze,
} from '../controllers/events.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

router.get('/', asyncHandler(list));
router.get('/pending', asyncHandler(pending));
router.get('/project/:projectId', asyncHandler(forProject));
router.post('/', asyncHandler(create));

// Transitions — une route par intention, jamais un PATCH générique sur le
// statut : « a eu lieu » et « n'a pas eu lieu » ne portent pas les mêmes
// informations, et un statut librement écrit contournerait la machine à états.
router.post('/:eventId/complete', asyncHandler(complete));
router.post('/:eventId/miss', asyncHandler(miss));
router.post('/:eventId/cancel', asyncHandler(cancel));
router.post('/:eventId/reschedule', asyncHandler(reschedule));
router.post('/:eventId/snooze', asyncHandler(snooze));

export default router;
