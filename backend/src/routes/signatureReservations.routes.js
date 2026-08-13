// RÉSERVATIONS DE SIGNATURE BLOQUÉES — surface d'exploitation (R10.5C).
//
// LECTURE pour tout compte du Panel : « pourquoi ce contrat ne démarre-t-il
// pas ? » est une question de support, et la réponse n'est pas un secret.
//
// LIBÉRATION réservée aux DEV, et c'est le geste le plus lourd de cette
// surface : il autorise une SECONDE demande de signature sur un contrat dont on
// ignore si la première a abouti. Si elle avait abouti, un signataire réel en
// recevra deux.
import { Router } from 'express';

import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  getPendingReservations,
  postReleaseReservation,
} from '../controllers/signatureReservations.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

router.get('/', asyncHandler(getPendingReservations));
router.post('/:operationId/release', requirePanelDev, asyncHandler(postReleaseReservation));

export default router;
