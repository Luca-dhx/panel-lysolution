/**
 * `/api/todo-lists` — toutes les routes derrière l'authentification du Panel.
 *
 * Des notes de travail internes, comme les tâches : rien n'est publié par le
 * pont.
 */
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  create,
  detail,
  list,
  remove,
  toggleItem,
  update,
} from '../controllers/todoLists.controller.js';

const router = Router();
router.use(asyncHandler(requirePanelUser));

router.get('/', asyncHandler(list));
router.post('/', asyncHandler(create));
router.get('/:listId', asyncHandler(detail));
router.patch('/:listId', asyncHandler(update));
router.patch('/:listId/items/:itemId', asyncHandler(toggleItem));
router.delete('/:listId', asyncHandler(remove));

export default router;
