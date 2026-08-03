// Contrôleurs du registre (surface interne /api/projects).
import ApiError from '../utils/ApiError.js';
import { created, ok } from '../utils/apiResponse.js';
import logger from '../utils/logger.js';
import {
  declareProject,
  describeConformity,
  getProjectOrThrow,
  listProjects,
  loadBusinessProjections,
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
  const projections = await loadBusinessProjections(records.map((r) => r.projectId));
  return ok(res, {
    projects: records.map((record) =>
      toPublicProject(record, now, projections.get(record.projectId))),
  });
}

export async function detail(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const projections = await loadBusinessProjections([record.projectId]);
  return ok(res, {
    project: toPublicProject(record, Date.now(), projections.get(record.projectId)),
    conformity: describeConformity(record),
  });
}

/**
 * DÉCLARE un projet à partir de son ADRESSE.
 *
 * `projectKey` n'est pas lu du corps de requête — volontairement. La clé est
 * une donnée technique interne : la laisser entrer par l'API, c'est laisser le
 * client choisir l'identifiant du registre. Un `projectKey` envoyé par un
 * client est donc ignoré en silence, et le test de non-régression le vérifie.
 *
 * L'identité est relue ICI par la sonde, jamais acceptée du client : le
 * frontend pourrait annoncer n'importe quoi. Sonde best-effort — un projet
 * pas encore déployé reste déclarable, sa clé sera réconciliée à l'appairage.
 */
export async function declare(req, res) {
  const { url = null, projectName = null, manifest = null } = req.body ?? {};

  let bridgeIdentity = null;
  const probed = await probeProjectUrl(url).catch(() => null);
  if (probed?.compatible) bridgeIdentity = probed.bridgeIdentity;

  const { record, pairingCode, pairingCodeExpiresAt } = await declareProject({
    publicBackendUrl: url,
    projectName,
    bridgeIdentity,
    manifest,
  });
  return created(res, {
    project: toPublicProject(record),
    probe: probed,
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
