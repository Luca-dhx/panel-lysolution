// FÉDÉRATION D'IDENTITÉ — routes (L12.A).
//
// ── DEUX MONTAGES, ET L'ORDRE EST LA GARANTIE ───────────────────────────────
//
// Le jeu de clés est monté AVANT toute garde d'authentification, et l'émission
// APRÈS. Ce n'est pas une commodité : un projet doit pouvoir lire le JWKS
// pendant qu'il vérifie une assertion, c'est-à-dire précisément quand il n'a
// aucune session Panel — il n'est pas un utilisateur, il est un vérificateur.
//
// Inversement, l'émission derrière `requirePanelUser` + `requirePanelDev` :
// l'assertion affirme « ce porteur est un développeur autorisé », et seul un
// développeur authentifié peut demander qu'on l'affirme de lui-même.
//
// ── POURQUOI `requirePanelDev` ALORS QUE LE SERVICE VÉRIFIE DÉJÀ LE RÔLE ────
//
// Défense en profondeur, et surtout LISIBILITÉ DE LA SURFACE : un lecteur des
// routes doit voir à qui elles s'adressent sans ouvrir le service. Le service
// revérifie parce qu'il est appelable autrement (tests, futur callback) ; la
// route déclare parce qu'elle est la porte.
import { Router } from 'express';

import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  getJwks,
  listFederationKeys,
  postProjectAssertion,
} from '../controllers/federation.controller.js';

const router = Router();

/* ── PUBLIC — aucune authentification, par nécessité ────────────────────── */
router.get('/.well-known/jwks.json', asyncHandler(getJwks));

/* ── OPÉRATEUR ─────────────────────────────────────────────────────────── */
router.use(asyncHandler(requirePanelUser));
router.use(requirePanelDev);

router.get('/keys', asyncHandler(listFederationKeys));
router.post('/projects/:projectId/assertion', asyncHandler(postProjectAssertion));

export default router;
