// API interne du registre — docs/architecture/02_PROJECT_REGISTRY.md §4.
// Lecture : tout utilisateur du Panel. Actions : comptes DEV.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  declare,
  cancelContract,
  contractDocument,
  contractOperations,
  deleteDestinationHandler,
  detail,
  list,
  markDestinationEmptyHandler,
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

// CONTRAT — lecture pour tous les comptes du Panel, DEMANDE de résiliation
// aussi : c'est un acte de gestion, pas une opération d'infrastructure.
router.get('/:projectId/contract/operations', asyncHandler(contractOperations));
router.get('/:projectId/contract/document', asyncHandler(contractDocument));
router.post('/:projectId/contract/cancel', asyncHandler(cancelContract));

// Sonde d'URL — POST par commodité de corps, mais AUCUNE écriture : elle
// interroge une adresse et rend un constat.
router.post('/probe', requirePanelDev, asyncHandler(probe));

router.post('/', requirePanelDev, asyncHandler(declare));
router.post('/:projectId/pairing-code', requirePanelDev, asyncHandler(regeneratePairingCode));
router.delete('/:projectId/pairing', requirePanelDev, asyncHandler(revokePairing));
router.put('/:projectId/manifest', requirePanelDev, asyncHandler(putManifest));
router.delete('/:projectId', requirePanelDev, asyncHandler(remove));

/**
 * ── DESTINATIONS D'UN PROJET ────────────────────────────────────────────────
 *
 * DEUX actions, et deux seulement. Il n'y a volontairement AUCUNE route pour
 * déployer, redéployer, migrer ou activer une destination : le déploiement est
 * piloté depuis le poste du projet, et c'est le projet qui annonce son
 * déménagement. Le Panel arbitre des états, il ne pilote pas un moteur.
 *
 * `empty`  : l'opérateur constate qu'il ne reste rien sur le serveur d'une
 *            destination déjà RETIRÉE. Le Panel ne le vérifie pas — il ne se
 *            connecte à aucun serveur de projet — et trace la déclaration.
 * `delete` : retire la fiche des listes. Audit et historique conservés.
 */
router.post('/destinations/:destinationId/empty', requirePanelDev, asyncHandler(markDestinationEmptyHandler));
router.delete('/destinations/:destinationId', requirePanelDev, asyncHandler(deleteDestinationHandler));

export default router;
