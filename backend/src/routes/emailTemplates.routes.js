// L'ÉDITEUR DE MODÈLES — routes DEV, scopées (L11.1).
//
// ── L'ORDRE DES GARDES, ET POURQUOI CELUI-LÀ ────────────────────────────────
//
//   1. `requirePanelUser`      qui parle
//   2. `requirePanelDev`       a-t-il le droit d'éditer du contenu du parc
//   3. `resolveTemplateScope`  SUR QUOI il agit — construit et VALIDE la portée
//
// La portée vient en dernier, et c'est délibéré : elle interroge le registre
// des projets, donc la base. Une requête anonyme ne doit pas pouvoir faire
// lire une collection en nommant un projet au hasard — c'est un oracle
// d'existence gratuit.
//
// ── QUI PEUT ADMINISTRER QUOI ───────────────────────────────────────────────
//
// Le Panel DEV administre TOUTES les portées : c'est lui qui dépanne le parc.
// Un projet, lui, n'atteint jamais ces routes — il passe par `/bridge/v1`, sous
// son jeton, et n'y voit que sa propre portée. Les deux surfaces sont
// distinctes par construction, pas par un test de rôle enfoui.
import { Router } from 'express';

import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import { resolveTemplateScope } from '../middlewares/templateScope.middleware.js';
import {
  getEmailTemplate,
  getEmailTemplateOwnership,
  getEmailTemplateReadiness,
  getEmailTemplateScopeComparison,
  getEmailTemplateScopes,
  getEmailTemplateVersion,
  getEmailTemplateVersions,
  listEmailTemplates,
  postEmailTemplatePreview,
  postEmailTemplateRestore,
  postEmailTemplateTestSend,
  putEmailTemplate,
} from '../controllers/emailTemplates.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));
router.use(requirePanelDev);
router.use(asyncHandler(resolveTemplateScope));

/**
 * MÉTA — montées AVANT `/:templateId`, sinon « scopes » et « ownership »
 * seraient lus comme des codes de template et refusés en 404.
 */
router.get('/scopes', asyncHandler(getEmailTemplateScopes));
router.get('/ownership', asyncHandler(getEmailTemplateOwnership));

router.get('/', asyncHandler(listEmailTemplates));
router.get('/:templateId', asyncHandler(getEmailTemplate));
router.put('/:templateId', asyncHandler(putEmailTemplate));
router.post('/:templateId/preview', asyncHandler(postEmailTemplatePreview));
router.get('/:templateId/readiness', asyncHandler(getEmailTemplateReadiness));
router.post('/:templateId/test-send', asyncHandler(postEmailTemplateTestSend));
router.get('/:templateId/versions', asyncHandler(getEmailTemplateVersions));
router.get('/:templateId/versions/:version', asyncHandler(getEmailTemplateVersion));
router.post('/:templateId/versions/:version/restore', asyncHandler(postEmailTemplateRestore));
/** Le même code dans toutes ses portées — lecture seule, aucun rendu. */
router.get('/:templateId/scopes', asyncHandler(getEmailTemplateScopeComparison));

export default router;
