import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import { login, me } from '../controllers/auth.controller.js';

const router = Router();

router.post('/login', asyncHandler(login));
router.get('/me', requirePanelUser, asyncHandler(me));

export default router;
