/**
 * `/api/tasks` — toutes les routes derrière l'authentification du Panel.
 *
 * Les tâches sont des notes de travail internes : elles nomment des prospects,
 * des montants et des clients. Aucune n'est publiée par le pont, exactement
 * comme la prospection.
 */
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  complete,
  create,
  detail,
  list,
  postpone,
  remove,
  reopen,
  update,
} from '../controllers/tasks.controller.js';

const router = Router();
router.use(asyncHandler(requirePanelUser));

router.get('/', asyncHandler(list));
router.post('/', asyncHandler(create));
router.get('/:taskId', asyncHandler(detail));
router.patch('/:taskId', asyncHandler(update));
router.post('/:taskId/complete', asyncHandler(complete));
router.post('/:taskId/reopen', asyncHandler(reopen));
router.post('/:taskId/postpone', asyncHandler(postpone));
router.delete('/:taskId', asyncHandler(remove));

export default router;
