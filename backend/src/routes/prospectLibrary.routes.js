/**
 * `/api/prospect-folders` et `/api/prospect-templates`.
 *
 * Derrière la même garde que la prospection : ce sont ses notes de travail —
 * un dossier nomme un segment de marché, un modèle porte notre argumentaire.
 * Aucun ne sort par le pont.
 */
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  createFolderHandler,
  createTemplateHandler,
  deleteFolderHandler,
  deleteTemplateHandler,
  listFoldersHandler,
  listTemplatesHandler,
  updateFolderHandler,
  updateTemplateHandler,
} from '../controllers/prospectLibrary.controller.js';

export const foldersRouter = Router();
foldersRouter.use(asyncHandler(requirePanelUser));
foldersRouter.get('/', asyncHandler(listFoldersHandler));
foldersRouter.post('/', asyncHandler(createFolderHandler));
foldersRouter.patch('/:folderId', asyncHandler(updateFolderHandler));
foldersRouter.delete('/:folderId', asyncHandler(deleteFolderHandler));

export const templatesRouter = Router();
templatesRouter.use(asyncHandler(requirePanelUser));
templatesRouter.get('/', asyncHandler(listTemplatesHandler));
templatesRouter.post('/', asyncHandler(createTemplateHandler));
templatesRouter.patch('/:templateId', asyncHandler(updateTemplateHandler));
templatesRouter.delete('/:templateId', asyncHandler(deleteTemplateHandler));
