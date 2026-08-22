import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import { authRateLimit } from '../middlewares/authRateLimit.middleware.js';
import {
  login,
  me,
  forgotPassword,
  resetPassword,
} from '../controllers/auth.controller.js';

const router = Router();

/**
 * ── LES POINTS OÙ DES IDENTIFIANTS SONT VÉRIFIÉS SONT LIMITÉS ─────────────
 *
 * ══ CE QUI EXISTAIT AVANT ════════════════════════════════════════════════
 *
 * RIEN. `POST /api/auth/login` acceptait autant de tentatives que le réseau
 * en portait. Le service de réinitialisation avait, lui, sa propre
 * temporisation — la connexion, qui est la porte principale, n’en avait
 * aucune.
 *
 * ══ TROIS PORTÉES, PARCE QUE CE SONT TROIS GESTES ════════════════════════
 *
 * Trop de tentatives de connexion ne doivent pas fermer la porte de la
 * réinitialisation : ce sont deux risques différents, et quelqu’un qui a
 * épuisé ses essais a précisément besoin de la seconde.
 */
router.post('/login', authRateLimit({ scope: 'panel-login' }), asyncHandler(login));
router.post('/forgot-password', authRateLimit({ scope: 'panel-forgot' }), asyncHandler(forgotPassword));
/**
 * La réinitialisation ne porte pas d’e-mail : son identité est le JETON. Le
 * limiter par jeton empêche de le deviner par force brute, ce qui est
 * exactement le risque de cette route.
 */
router.post(
  '/reset-password',
  authRateLimit({ scope: 'panel-reset', identityFrom: (req) => req.body?.token ?? null }),
  asyncHandler(resetPassword),
);
router.get('/me', asyncHandler(requirePanelUser), asyncHandler(me));

export default router;
