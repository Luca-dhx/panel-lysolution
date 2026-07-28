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
import { probeProjectUrl } from '../services/registry/probe.service.js';

export async function list(_req, res) {
  const now = Date.now();
  const records = await listProjects();
  return ok(res, { projects: records.map((record) => toPublicProject(record, now)) });
}

export async function detail(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  return ok(res, {
    project: toPublicProject(record),
    conformity: describeConformity(record),
  });
}

export async function declare(req, res) {
  const { projectKey, projectName, manifest = null } = req.body ?? {};
  const { record, pairingCode, pairingCodeExpiresAt } = await declareProject({
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

export async function regeneratePairingCode(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const { code, expiresAt } = await issuePairingCode(record);
  return ok(res, { pairingCode: code, pairingCodeExpiresAt: expiresAt });
}

export async function revokePairing(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  if (record.pairing.status !== 'PAIRED') {
    throw ApiError.conflict('PANEL_PROJECT_NOT_PAIRED', 'Ce projet n’est pas appairé.');
  }
  const { previousToken } = await revokeFromPanel(record);

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

export async function putManifest(req, res) {
  const { manifest } = req.body ?? {};
  const { record, unknownFeatures } = await updateManifest(req.params.projectId, manifest);
  return ok(res, { project: toPublicProject(record), unknownFeatures });
}

export async function remove(req, res) {
  return ok(res, await removeProject(req.params.projectId));
}

/**
 * SONDE d'une URL de projet — avant tout appairage.
 *
 * Ne cree rien, ne modifie rien. Evite les trois echecs les plus courants
 * d'un premier appairage : mauvaise URL, contrat majeur incompatible, projet
 * deja appaire ailleurs. La decouverte complete vient apres, par l'action
 * DISCOVER_PROJECT — quand le Panel a le droit de la demander.
 */
export async function probe(req, res) {
  const url = req.body?.url ?? req.query?.url ?? null;
  if (!url) {
    throw ApiError.badRequest('PANEL_PROBE_URL_REQUIRED',
      'Sonde impossible parce qu’aucune URL n’a ete fournie.');
  }
  return ok(res, await probeProjectUrl(url));
}
