// Configuration système du Panel — docs/architecture/24_ENVIRONMENT_AND_DOMAINS.md.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import { getNetwork, putNetwork } from '../controllers/network.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

router.get('/network', asyncHandler(getNetwork));
router.put('/network', requirePanelDev, asyncHandler(putNetwork));

export default router;
