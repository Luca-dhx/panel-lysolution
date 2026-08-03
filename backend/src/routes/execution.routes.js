// Pilotage — docs/architecture/44_EXECUTION_ENGINE.md.
//
// PREMIÈRE surface d'ÉCRITURE du Panel depuis la Phase 3A. Elle est
// volontairement étroite : quatre verbes d'écriture, tous passant par le
// moteur d'exécution, aucun ne touchant directement un projet.
//
// Il n'existe AUCUNE route qui exécute une action sans créer d'exécution :
// c'est ce qui rend le contournement du moteur impossible par construction.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  actions,
  cancel,
  confirm,
  create,
  detail,
  history,
  prepare,
  queue,
  stats,
} from '../controllers/execution.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));
// Surface TECHNIQUE : réservée aux comptes DEV, comme les écrans qui la
// consomment. La garde du frontend redirige un ADMIN ; sans cette ligne, la
// donnée restait atteignable par appel direct à l'API.
router.use(requirePanelDev);

// — Lecture ----------------------------------------------------------------
router.get('/actions', asyncHandler(actions));
router.get('/stats', asyncHandler(stats));
router.get('/queue', asyncHandler(queue));
router.get('/', asyncHandler(history));

// — Préparation (aucune écriture : POST par commodité de corps) -------------
router.post('/prepare', asyncHandler(prepare));

// — Écriture ---------------------------------------------------------------
router.post('/', asyncHandler(create));
router.post('/:executionId/confirm', asyncHandler(confirm));
router.post('/:executionId/cancel', asyncHandler(cancel));

// Placé APRÈS les routes littérales pour ne pas capturer « /actions ».
router.get('/:executionId', asyncHandler(detail));

export default router;
