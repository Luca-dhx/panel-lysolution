// API interne du registre — docs/architecture/02_PROJECT_REGISTRY.md §4.
// Lecture : tout utilisateur du Panel. Actions : comptes DEV.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  declare,
  detail,
  list,
  probe,
  putManifest,
  regeneratePairingCode,
  remove,
  revokePairing,
} from '../controllers/projects.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

router.get('/', asyncHandler(list));
router.get('/:projectId', asyncHandler(detail));

// Sonde d'URL — POST par commodité de corps, mais AUCUNE écriture : elle
// interroge une adresse et rend un constat.
router.post('/probe', requirePanelDev, asyncHandler(probe));

router.post('/', requirePanelDev, asyncHandler(declare));
router.post('/:projectId/pairing-code', requirePanelDev, asyncHandler(regeneratePairingCode));
router.delete('/:projectId/pairing', requirePanelDev, asyncHandler(revokePairing));
router.put('/:projectId/manifest', requirePanelDev, asyncHandler(putManifest));
router.delete('/:projectId', requirePanelDev, asyncHandler(remove));

export default router;
