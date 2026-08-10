// Surface publique de pont — implémentation serveur de
// docs/spec/PanelBridge.openapi.yaml, montée sous /bridge/v1.
// Ordre contractuel des gardes : version de contrat sur TOUT le routeur
// (ping compris), puis routes publiques (ping, bootstrap), puis bridgeToken.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import bridgeContractVersionGuard from '../middlewares/bridgeContractVersion.middleware.js';
import requireBridgeAuth from '../middlewares/bridgeAuth.middleware.js';
import {
  bootstrapPairing,
  heartbeat,
  ping,
  syncPull,
  syncPush,
  unpair,
} from '../controllers/bridge.controller.js';
import { invoke as invokeCapability } from '../controllers/capabilities.controller.js';

const router = Router();

router.use(bridgeContractVersionGuard);

router.get('/ping', ping);
router.post('/pairings', asyncHandler(bootstrapPairing));

router.delete('/pairings/current', asyncHandler(requireBridgeAuth), asyncHandler(unpair));

router.use(asyncHandler(requireBridgeAuth));
router.post('/heartbeats', asyncHandler(heartbeat));
router.post('/sync/push', asyncHandler(syncPush));
router.get('/sync/pull', asyncHandler(syncPull));

/**
 * PASSERELLE DE CAPACITÉS (contrat 1.5.0) — montée APRÈS `requireBridgeAuth`,
 * et c'est tout l'enjeu : le `projectId` qui fera autorité vient du jeton,
 * jamais de l'URL ni du corps. Un montage au-dessus de la garde rendrait la
 * capacité anonyme, donc adressable par n'importe qui.
 */
router.post('/capabilities/:code/invoke', asyncHandler(invokeCapability));

export default router;
