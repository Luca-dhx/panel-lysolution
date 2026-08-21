// Contrôleurs de la surface /bridge/v1 — fins : validation par le miroir de
// contrat, logique dans les services, enveloppes communes.
import {
  bootstrapRequestSchema,
  heartbeatSchema,
  nowIso,
  parseOrThrow,
  syncPullQuerySchema,
  syncPushRequestSchema,
} from '../bridge/bridgeContract.js';
import { created, ok } from '../utils/apiResponse.js';
import { bootstrap, unpairByProject } from '../services/pairing/pairing.service.js';
import { recordHeartbeat } from '../services/registry/projectRegistry.service.js';
import { evaluateBridgeConsumption } from '../services/supervision/bridgeAlerting.service.js';
import { archiveHeartbeat } from '../services/supervision/heartbeat.service.js';
import { applyIncoming, pullForProject } from '../services/sync/syncCore.service.js';

export function ping(_req, res) {
  return ok(res, { status: 'ok', service: 'panel-bridge-api', time: nowIso() });
}

export async function bootstrapPairing(req, res) {
  const dto = parseOrThrow(bootstrapRequestSchema, req.body, 'BootstrapRequest');
  return created(res, await bootstrap(dto));
}

export async function unpair(req, res) {
  return ok(res, await unpairByProject(req.bridgeProject));
}

export async function heartbeat(req, res) {
  const dto = parseOrThrow(heartbeatSchema, req.body, 'Heartbeat');
  // ORDRE IMPORTANT : l'archivage compare le heartbeat à l'état PRÉCÉDENT
  // pour en déduire les changements (version, santé, redémarrage). Il doit
  // donc s'exécuter AVANT que la fiche ne soit mise à jour.
  await archiveHeartbeat(req.bridgeProject, dto);
  await recordHeartbeat(req.bridgeProject, dto, req.bridgeContractVersion ?? null);

  /**
   * ── LA CONSOMMATION EST ÉVALUÉE ICI, ET NULLE PART AILLEURS ──────────────
   *
   * ══ POURQUOI SUR LE BATTEMENT ═══════════════════════════════════════════
   *
   * C'est le SEUL instant où le Panel apprend quelque chose de neuf sur ce que
   * le projet a consommé. L'évaluer depuis un écran ferait partir une alerte
   * parce que quelqu'un a ouvert une page ; l'évaluer depuis un ordonnanceur
   * ajouterait une boucle là où une déclaration existe déjà.
   *
   * ══ APRÈS L'ENREGISTREMENT, ET SANS L'ATTENDRE ══════════════════════════
   *
   * Après : l'évaluation lit `record.runtime.bridgeStats`, qui vient d'être
   * écrit. Avant, elle jugerait le battement précédent.
   *
   * Sans l'attendre : un battement est un signe de vie, et il doit être
   * acquitté immédiatement. Le faire dépendre d'un envoi d'e-mail ferait
   * basculer une fiche « hors ligne » parce qu'un fournisseur de messagerie
   * était lent — c'est-à-dire créer une panne pour en signaler une autre.
   * `evaluateBridgeConsumption` ne lève jamais, et son `.catch` est une
   * ceinture, pas une politique.
   */
  void evaluateBridgeConsumption(req.bridgeProject).catch(() => {});

  return ok(res, { acknowledged: true, panelTime: nowIso() });
}

export async function syncPush(req, res) {
  const dto = parseOrThrow(syncPushRequestSchema, req.body, 'SyncPushRequest');
  return ok(res, await applyIncoming(req.bridgeProject.projectId, dto.changes));
}

export async function syncPull(req, res) {
  const query = parseOrThrow(syncPullQuerySchema, req.query, 'SyncPullQuery');
  return ok(res, await pullForProject(req.bridgeProject.projectId, query));
}
