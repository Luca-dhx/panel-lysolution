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
  await recordHeartbeat(req.bridgeProject, dto);
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
