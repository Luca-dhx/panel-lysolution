// Contrôleurs du registre (surface interne /api/projects).
import ApiError from '../utils/ApiError.js';
import { created, ok } from '../utils/apiResponse.js';
import logger from '../utils/logger.js';
import {
  declareProject,
  describeConformity,
  getProjectOrThrow,
  listProjects,
  removeProject,
  toPublicProject,
  updateManifest,
} from '../services/registry/projectRegistry.service.js';
import {
  issuePairingCode,
  revokeFromPanel,
} from '../services/pairing/pairing.service.js';
import ProjectBridgeClient from '../bridge/ProjectBridgeClient.js';

export function list(_req, res) {
  const now = Date.now();
  return ok(res, { projects: listProjects().map((record) => toPublicProject(record, now)) });
}

export function detail(req, res) {
  const record = getProjectOrThrow(req.params.projectId);
  return ok(res, {
    project: toPublicProject(record),
    conformity: describeConformity(record),
  });
}

export function declare(req, res) {
  const { projectKey, projectName, manifest = null } = req.body ?? {};
  const { record, pairingCode, pairingCodeExpiresAt } = declareProject({
    projectKey,
    projectName,
    manifest,
  });
  return created(res, {
    project: toPublicProject(record),
    pairingCode,
    pairingCodeExpiresAt,
  });
}

export function regeneratePairingCode(req, res) {
  const record = getProjectOrThrow(req.params.projectId);
  const { code, expiresAt } = issuePairingCode(record);
  return ok(res, { pairingCode: code, pairingCodeExpiresAt: expiresAt });
}

export async function revokePairing(req, res) {
  const record = getProjectOrThrow(req.params.projectId);
  if (record.pairing.status !== 'PAIRED') {
    throw ApiError.conflict('PANEL_PROJECT_NOT_PAIRED', 'Ce projet n’est pas appairé.');
  }
  const { previousToken } = revokeFromPanel(record);

  // Courtoisie de propagation, best-effort : le projet constatera de toute
  // façon le 401 à son prochain appel et passera STANDALONE de lui-même.
  if (previousToken && record.runtime.publicBackendUrl) {
    try {
      const client = new ProjectBridgeClient({
        baseUrl: record.runtime.publicBackendUrl,
        bridgeToken: previousToken,
      });
      await client.notifyUnpair();
    } catch {
      logger.warn(`Notification de désappairage impossible pour ${record.projectKey} (best-effort).`);
    }
  }
  return ok(res, { project: toPublicProject(record) });
}

export function putManifest(req, res) {
  const { manifest } = req.body ?? {};
  const { record, unknownFeatures } = updateManifest(req.params.projectId, manifest);
  return ok(res, { project: toPublicProject(record), unknownFeatures });
}

export function remove(req, res) {
  return ok(res, removeProject(req.params.projectId));
}
