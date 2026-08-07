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
  loadProjectTeam,
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
import {
  listContractActions,
  listContractOperations,
  requestContractAction,
  requestContractProtection,
} from '../services/contract/contractActions.service.js';
import { getOutboundBridgeToken } from '../services/pairing/pairing.service.js';
import { PanelProjectContract } from '../models/PanelProjectProjection.model.js';
import {
  deleteDestination, describeByEnvironment, destinationKey, loadActiveDestinationHosts,
  markDestinationEmpty, outboundBaseUrl,
} from '../services/registry/projectDestination.service.js';

/**
 * Ce que la fiche doit savoir pour dater la génération d'un projet.
 *
 * L'hôte de la destination ACTIVE entre dans la clé de génération, et la
 * projection publique est synchrone : sans ce chargement, elle le devinait —
 * et le devinait faux, ce qui déclarait périmée toute photographie reçue.
 */
async function hotesActifs(records) {
  return loadActiveDestinationHosts(
    records.map((r) => ({ projectId: r.projectId, environment: r.runtime?.environment ?? null })),
  );
}

const hoteDe = (carte, record) =>
  carte.get(destinationKey(record.projectId, record.runtime?.environment ?? null)) ?? null;

export async function list(_req, res) {
  const now = Date.now();
  const records = await listProjects();
  const [projections, hotes] = await Promise.all([
    loadBusinessProjections(records.map((r) => r.projectId)),
    hotesActifs(records),
  ]);
  return ok(res, {
    projects: records.map((record) =>
      toPublicProject(record, now, projections.get(record.projectId), hoteDe(hotes, record))),
  });
}

export async function detail(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const [projections, team, hotes] = await Promise.all([
    loadBusinessProjections([record.projectId]),
    loadProjectTeam(record.projectId),
    hotesActifs([record]),
  ]);
  const project = toPublicProject(
    record, Date.now(), projections.get(record.projectId), hoteDe(hotes, record),
  );
  // L'équipe n'est pas une propriété du registre : elle est jointe ICI, sur la
  // fiche seule, parce que c'est le seul écran qui la montre.
  project.business.team = team.map((m) => ({
    entityId: m.entityId,
    name: m.name,
    email: m.email,
    role: m.role,
    createdAt: m.createdAt,
    receivedAt: m.receivedAt,
  }));
  /**
   * LES DESTINATIONS, GROUPÉES PAR ENVIRONNEMENT.
   *
   * L'écran montre, pour TEST et pour PROD, la destination active et
   * l'historique. Jamais une liste plate où deux environnements se
   * mélangeraient à l'œil — c'est précisément la confusion qu'on corrige.
   */
  const destinations = await describeByEnvironment(record.projectId);
  return ok(res, { project, conformity: describeConformity(record), destinations });
}

/**
 * RETIRED → EMPTY. L'opérateur constate qu'il ne reste rien sur le serveur.
 *
 * Le Panel ne le vérifie pas : il ne se connecte à aucun serveur de projet, et
 * ne déploie rien. C'est une déclaration humaine, tracée comme telle.
 */
export async function markDestinationEmptyHandler(req, res) {
  return ok(res, await markDestinationEmpty(req.params.destinationId, {
    actor: req.panelUser?.email ?? null,
  }));
}

/** EMPTY → DELETED. Suppression LOGIQUE : audit et historique conservés. */
export async function deleteDestinationHandler(req, res) {
  return ok(res, await deleteDestination(req.params.destinationId, {
    actor: req.panelUser?.email ?? null,
  }));
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
  const {
    url = null, projectName = null, manifest = null,
    /**
     * L'ENVIRONNEMENT VISÉ — la seule chose que l'appelant ajoute, et il ne
     * l'invente pas : l'écran l'a déjà, puisqu'on déclare « la production de
     * ce projet » depuis la fiche de sa recette. `null` reste accepté et
     * reproduit exactement le comportement d'avant.
     */
    environment = null,
  } = req.body ?? {};

  let bridgeIdentity = null;
  const probed = await probeProjectUrl(url).catch(() => null);
  if (probed?.compatible) bridgeIdentity = probed.bridgeIdentity;

  const { record, pairingCode, pairingCodeExpiresAt } = await declareProject({
    publicBackendUrl: url,
    projectName,
    bridgeIdentity,
    manifest,
    environment,
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
  if (previousToken && outboundBaseUrl(record)) {
    try {
      const client = new ProjectBridgeClient({
        baseUrl: outboundBaseUrl(record),
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


/* ── CONTRAT : ce que le Panel peut DEMANDER au projet ────────────────────── */

/** GET /:projectId/contract/operations — catalogue vivant + historique. */
export async function contractOperations(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const catalogue = await listContractOperations(record);
  return ok(res, {
    ...catalogue,
    environment: record.runtime?.environment ?? null,
    history: await listContractActions(record.projectId),
  });
}

/**
 * POST /:projectId/contract/cancel — DEMANDE de résiliation.
 *
 * Le Panel ne touche pas à sa projection : la nouvelle vérité lui reviendra
 * par la synchronisation, comme toute autre modification du contrat.
 */
export async function cancelContract(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const { operationId, reason = null } = req.body ?? {};
  const { action } = await requestContractAction(record, {
    operationId,
    reason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : null,
    actor: {
      userId: req.panelUser?.userId ?? null,
      email: req.panelUser?.email ?? null,
      role: req.panelUser?.role ?? null,
    },
  });
  return ok(res, { action });
}

/**
 * POST /:projectId/contract/protection — RÈGLE la protection contractuelle.
 *
 * Le Panel ne conserve aucune copie de ce réglage : il le demande au projet,
 * qui l'applique et rend l'état constaté après réconciliation. La valeur
 * affichée est ensuite relue au projet — c'est ce qui garantit que le Panel et
 * le Manager ne peuvent pas afficher deux valeurs différentes.
 */
export async function setContractProtectionHandler(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const { enabled } = req.body ?? {};
  const { action, contractProtection } = await requestContractProtection(record, {
    enabled,
    actor: {
      userId: req.panelUser?.userId ?? null,
      email: req.panelUser?.email ?? null,
      role: req.panelUser?.role ?? null,
    },
  });
  return ok(res, { action, contractProtection });
}

/**
 * GET /:projectId/contract/document — le PDF, relayé depuis le projet.
 *
 * Le Panel ne STOCKE aucun document contractuel : il va le chercher chez son
 * propriétaire, avec son jeton de pont, et le relaie à l'utilisateur. Le
 * chemin vient de la projection — le Panel ne le fabrique pas.
 */
export async function contractDocument(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const projection = await PanelProjectContract.findOne({ projectId: record.projectId }).lean();
  const chemin = projection?.document?.downloadPath;
  if (!projection?.document?.available || !chemin) {
    throw ApiError.notFound(
      'PANEL_CONTRACT_DOCUMENT_UNAVAILABLE',
      'Aucun document contractuel n’a été publié par ce projet.',
    );
  }

  const bridgeToken = record.pairing?.status === 'PAIRED' ? getOutboundBridgeToken(record) : null;
  if (!bridgeToken || !outboundBaseUrl(record)) {
    throw ApiError.conflict(
      'PANEL_PROJECT_NOT_PAIRED',
      'Le lien avec ce projet est rompu : le document ne peut pas être récupéré.',
    );
  }

  const client = new ProjectBridgeClient({
    baseUrl: outboundBaseUrl(record),
    bridgeToken,
  });
  const amont = await client.fetchDocument(chemin);
  if (!amont.ok) {
    throw ApiError.conflict(
      'PANEL_CONTRACT_DOCUMENT_UNREACHABLE',
      `Le projet n’a pas rendu le document (HTTP ${amont.status}).`,
    );
  }

  const nom = projection.document.filename || 'contrat.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nom.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(Buffer.from(await amont.arrayBuffer()));
}
