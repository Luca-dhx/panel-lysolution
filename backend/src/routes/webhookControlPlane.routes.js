// ROUTES DU PLAN DE CONTRÔLE WEBHOOK — surface interne, authentifiée (L5).
//
// Même répartition que `integratedApi.routes.js`, et pour la même raison :
//
//   LECTURE  — tout compte authentifié. « Stripe PROD est READY, vérifié il y
//              a six minutes » est un diagnostic d'exploitation. Un ADMIN doit
//              pouvoir constater qu'un webhook a dérivé sans dépendre d'un DEV.
//
//   ÉCRITURE — DEV uniquement. Réconcilier n'est pas une lecture : cela CRÉE,
//              MODIFIE ou RETIRE un endpoint sur un compte fournisseur réel, et
//              cela consomme une place sur le plafond de 16 de Stripe.
//
// S'écarter de cette répartition créerait deux doctrines pour un même risque.
import { Router } from 'express';

import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  listWebhookStates,
  getWebhookState,
  reconcileAll,
  reconcileOne,
} from '../controllers/webhookControlPlane.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

// — Lecture ----------------------------------------------------------------
router.get('/', asyncHandler(listWebhookStates));
router.get('/:provider', asyncHandler(getWebhookState));

// — Écriture : DEV uniquement ----------------------------------------------
router.use(requirePanelDev);

router.post('/reconcile', asyncHandler(reconcileAll));
router.post('/:provider/reconcile', asyncHandler(reconcileOne));

export default router;
