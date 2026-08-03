// Thème du Panel — lecture ouverte à tout compte (l'app en a besoin pour
// s'afficher), écriture réservée aux comptes DEV.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import { ok } from '../utils/apiResponse.js';
import {
  getPanelTheme,
  resetPanelTheme,
  savePanelTheme,
} from '../services/theme/panelTheme.service.js';

const router = Router();
router.use(asyncHandler(requirePanelUser));

router.get('/', asyncHandler(async (_req, res) => ok(res, { theme: await getPanelTheme() })));
router.put('/', requirePanelDev, asyncHandler(async (req, res) =>
  ok(res, { theme: await savePanelTheme(req.body ?? {}) })));
router.post('/reset', requirePanelDev, asyncHandler(async (_req, res) =>
  ok(res, { theme: await resetPanelTheme() })));

export default router;
