// Entreprise et APIs intégrées — docs/architecture/57_COMPANY_CONFIGURATION.md.
//
// Lecture : tout utilisateur authentifié du Panel.
// Écriture : comptes DEV uniquement. La raison n'est pas hiérarchique — ces
// routes portent les identifiants d'accès aux services tiers de l'entreprise
// et l'identité publique de tous ses sites. Une erreur ici se voit sur
// l'ensemble du parc.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  apis,
  create,
  createIntegratedApi,
  current,
  grant,
  projectGrants,
  publish,
  putCredentials,
  removeIntegratedApi,
  restore,
  revoke,
  update,
  updateIntegratedApi,
  version,
  versions,
} from '../controllers/company.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

// — Lecture ----------------------------------------------------------------
router.get('/', asyncHandler(current));
router.get('/versions', asyncHandler(versions));
router.get('/versions/:version', asyncHandler(version));
router.get('/integrated-apis', asyncHandler(apis));
router.get('/integrated-apis/projects/:projectId', asyncHandler(projectGrants));

// — Écriture : DEV uniquement ----------------------------------------------
router.use(requirePanelDev);

router.post('/', asyncHandler(create));
router.patch('/', asyncHandler(update));
router.post('/publish', asyncHandler(publish));
router.post('/versions/:version/restore', asyncHandler(restore));

router.post('/integrated-apis', asyncHandler(createIntegratedApi));
router.patch('/integrated-apis/:apiId', asyncHandler(updateIntegratedApi));
router.delete('/integrated-apis/:apiId', asyncHandler(removeIntegratedApi));
router.put('/integrated-apis/:apiId/credentials/:mode', asyncHandler(putCredentials));
router.post('/integrated-apis/:apiId/grants', asyncHandler(grant));
router.delete('/integrated-apis/:apiId/grants/:projectId', asyncHandler(revoke));

export default router;
