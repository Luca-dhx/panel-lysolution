// EXPÉDITEUR E-MAIL GLOBAL — surface interne /api/email-sender (R10.4).
//
// LECTURE pour tout compte du Panel : « depuis quelle adresse écrivons-nous ? »
// est la première question quand un client dit n'avoir rien reçu, et ce n'est
// pas un secret — l'adresse figure dans chaque message envoyé.
//
// ÉCRITURE et TEST réservés aux DEV, pour deux raisons distinctes :
//
//   · l'écriture change l'expéditeur de TOUT le parc d'un seul geste, projets
//     et Panel compris ;
//   · le test envoie un e-mail RÉEL, avec le compte de la plateforme, et
//     consomme son quota.
import { Router } from 'express';

import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  getEmailSender,
  putEmailSender,
  postEmailSenderTest,
  getEmailSenderTest,
  putPublicContactEmail,
} from '../controllers/emailSender.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

router.get('/', asyncHandler(getEmailSender));
router.put('/', requirePanelDev, asyncHandler(putEmailSender));

/**
 * LE CONTACT PUBLIC — même écran, même garde, autorité différente.
 *
 * Il est monté ici parce que c'est ici qu'on le confond avec l'expéditeur ;
 * il est écrit dans l'entreprise du Panel parce que c'est elle que les projets
 * reçoivent. Une route par écran n'implique pas une vérité par écran.
 */
router.put('/public-contact', requirePanelDev, asyncHandler(putPublicContactEmail));

router.post('/test', requirePanelDev, asyncHandler(postEmailSenderTest));
/**
 * La RELECTURE d'un test est ouverte à tout compte du Panel : elle n'envoie
 * rien, et attendre un webhook ne doit pas exiger le compte qui a déclenché
 * l'envoi.
 */
router.get('/test/:testId', asyncHandler(getEmailSenderTest));

export default router;
