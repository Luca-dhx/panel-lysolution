// API interne du registre — docs/architecture/02_PROJECT_REGISTRY.md §4.
// Lecture : tout utilisateur du Panel. Actions : comptes DEV.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  accounts,
  deadLetters,
  replayDeadLetterHandler,
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
  setContractProtectionHandler,
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

/**
 * PROTECTION CONTRACTUELLE — réservée aux comptes DEV.
 *
 * Elle décide si un site est servi ou suspendu : c'est un cran au-dessus d'une
 * demande de résiliation, qui ne fait que transmettre une intention sur un
 * contrat déjà connu. Le projet, lui, authentifie le PONT et non l'humain — la
 * règle d'accès ne peut donc être portée qu'ici, jamais par un bouton masqué.
 */
router.post(
  '/:projectId/contract/protection',
  requirePanelDev,
  asyncHandler(setContractProtectionHandler),
);

// Sonde d'URL — POST par commodité de corps, mais AUCUNE écriture : elle
// interroge une adresse et rend un constat.
/**
 * LES COMPTES D'UN PROJET — lecture VIVANTE, capacités développeur.
 *
 * Montée avec les autres lectures de fiche. Elle ne mute rien : c'est une
 * fenêtre sur l'autorité voisine, pas une prise de contrôle.
 */
router.get('/:projectId/accounts', requirePanelDev, asyncHandler(accounts));

/**
 * ÉCRITURES GARÉES — lecture pour les comptes DEV, rejeu aussi.
 *
 * Republier un fait vers un projet est un acte d'INFRASTRUCTURE : il fait
 * apparaître une écriture dans le flux durable d'un client. La lecture l'est
 * tout autant — elle nomme des entités métier d'un projet tiers.
 */
router.get('/:projectId/dead-letters', requirePanelDev, asyncHandler(deadLetters));
router.post(
  '/:projectId/dead-letters/:writeId/replay',
  requirePanelDev,
  asyncHandler(replayDeadLetterHandler),
);
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

/**
 * ── QUATRE ROUTES ONT ÉTÉ SUPPRIMÉES ICI ────────────────────────────────────
 *
 *   GET/PUT  /:projectId/capability-grants
 *   GET/PUT  /:projectId/commercial-readiness
 *
 * Les deux premières éditaient la liste des capacités cochées d'un projet ; les
 * deux suivantes ouvraient ou refermaient son commerce. Toutes quatre servaient
 * à débloquer, projet par projet, un chemin que l'appairage avait déjà établi.
 *
 * Le catalogue des actions servies par cette instance reste lisible, mais il
 * n'est plus rattaché à un projet : `GET /api/integrated-api/capabilities`.
 */

export default router;
